# Architecture

This document is for **contributors** — people writing code in this repo
or adding a new runtime adapter. End-user docs live in the root
[`README.md`](../README.md). The conceptual rationale — *why* emploke is
shaped the way it is — lives in the paper
[*What we believe about agentic systems*](https://langsensei.github.io/emploke/).

## Layering

The repo is one [pnpm workspace](https://pnpm.io/workspaces) of 11
packages with a strict layering. Higher layers may depend on lower
layers; never the reverse.

```text
                ┌────────────────────────┐
                │ @emploke/dashboard     │  React + Vite SPA
                └───────────▲────────────┘
                            │ HTTP /api/*
                ┌───────────┴────────────┐
                │ @emploke/server        │  Hono routes + middleware
                └───────────▲────────────┘
                            │
   ┌───────────┬────────────┼────────────┬───────────────┐
   │           │            │            │               │
┌──┴──┐  ┌─────┴─────┐ ┌────┴────┐ ┌─────┴─────┐  ┌──────┴──────┐
│task │  │ session   │ │ catalog │ │ workspace │  │   runtime   │
└──▲──┘  └─────▲─────┘ └────▲────┘ └─────▲─────┘  └──────▲──────┘
   │           │            │            │               │
   └───────────┴────────────┼────────────┘               │
                            │                            │
                   ┌────────┴───────┐         ┌──────────┴─────────┐
                   │   @emploke/fs   │        │ @emploke/terminal  │
                   │  atomic IO + locks       └────────────────────┘
                   └────────▲────────┘
                            │
                   ┌────────┴────────┐    ┌─────────────────┐
                   │ @emploke/paths  │    │ @emploke/logger │
                   │  env → fs paths │    │  pino + roll    │
                   └─────────────────┘    └─────────────────┘
```

The entity packages (`workspace`, `session`, `task`, `catalog`) sit at
the same level — they don't depend on each other directly. Composition
happens at the server layer: the server holds one `WorkspaceManager`
process-wide and lazily mints per-workspace `CatalogManager` /
`SessionManager` / `TaskManager` instances behind a context cache.
`runtime` is consumed by `session` + `task` to spawn agents.

## Repository pattern

Every entity package follows the same shape: a **Manager** facade plus a
**Repository** abstraction, with file-system implementations supplied by
default and in-memory implementations exposed on the package's
`testing` subpath.

```ts
// e.g. packages/workspace/src/repositories/repository.ts
export interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  read(id: string): Promise<Workspace | null>;
  save(workspace: Workspace): Promise<void>;        // upsert
  create(workspace: Workspace): Promise<void>;      // atomic create-or-fail
  delete(id: string): Promise<void>;
  getCurrent(): Promise<string | null>;
  setCurrent(id: string): Promise<void>;
}
```

Three properties matter:

1. **Domain types are clean.** `Workspace`, `Task`, `Session`, `Skill`,
   `Agent` are flat value types with no `schemaVersion`, no `metadata`
   wrapper, no fs-shaped fields beyond a single `workdir` on `Workspace`.
   The `schemaVersion` lives only inside the repository's wire format
   (FS-backed entities wrap the value in `{schemaVersion: N, ...fields}`
   on disk; SQLite-backed entities track it in a `schema_meta` row);
   the manager strips it on read.
2. **Repositories are bytes in / bytes out.** They never parse
   frontmatter, build dependency graphs, or maintain caches — those are
   manager concerns. The repository's job is "given an id, return the
   stored value (or null)."
3. **InMemory implementations exist for FS-backed entity tests.** Every
   FS-backed entity package (today: `workspace`) exports one at
   `@emploke/<pkg>/testing`. SQLite-backed entities (catalog, session,
   task) instead expose their `Sqlite*Repository` constructed with
   `":memory:"` for the same role — isolated, lifetime-of-the-test,
   validates ids the same way the on-disk DB does.

## `@emploke/fs`: the atomic IO seam

Every FS-touching operation in the repo goes through one of four
primitives in [`packages/fs`](../packages/fs):

| Primitive               | What it guarantees                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `writeFileAtomic`       | Write-temp + rename. Survives mid-write crashes; readers see old or new bytes, never partial. EPERM/EACCES retry on Windows.  |
| `writeJsonAtomic`       | `writeFileAtomic` + `JSON.stringify` with trailing newline.                                                                   |
| `readJson`              | `readFile` + `JSON.parse` with a 10 MB cap (DoS guard); double-checked post-read to defeat stat/read TOCTOU races.            |
| `withFileLock`          | Advisory lock backed by an `O_EXCL` lockfile, with PID-aware stale recovery (stuck PID → wait; dead PID → steal).             |

These are the **only** allowed paths to durable state in the FS-backed
repo. A catalog `write()`, a workspace registry mutation, a runtime
breadcrumb save — all flow through these. CI failures and production
incidents disappear when an entity rewrite forgets to use them; the
parameterised regression test in
`packages/catalog/test/fs-repositories.test.ts` spies on
`writeFileAtomic` to keep that from happening again. SQLite-backed
entities (catalog, session, task) get the equivalent guarantees from
WAL mode + transactions and don't go through this layer.

## Backend selection: when SQLite

emploke deliberately keeps its persistence backend simple and consistent.
Today **every entity is SQLite-backed**, but the DBs are split by
**scope** (where the data lives in the lifetime hierarchy), not by
entity:

- **`<EMPLOKE_HOME>/global.db`** — workspace registry + cross-workspace
  state (current-workspace pointer, future audit logs, etc).
- **`<workspace>/workspace.db`** — every per-workspace entity (catalog,
  session, task, future workflow). One connection serves them all,
  shared via DI from `WorkspaceContext`.

Each pkg owns its own tables inside the shared DB and registers its
schema version in a multi-row `schema_meta(pkg TEXT PK, version INT)`
table so pkgs can evolve independently. The manager holds no
in-memory snapshot — SQLite is the source of truth and reads run in
autocommit so external writes are observable on the next request.

Why one DB per scope rather than one DB per entity:
- Cross-entity JOINs and atomic multi-table transactions are cheap
  (no `ATTACH DATABASE` dance).
- File handle count per workspace is exactly one.
- Backup / migration / diagnostic story is a single file.
- Mirrors industry norm for desktop SQLite apps (Copilot CLI,
  Obsidian, Logseq) where data sharing across "modules" within a
  single workspace is the default.

### When NOT SQLite (intentionally on the filesystem)

- **Agent workdirs** — `<workspace>/sessions/<id>/`,
  `<workspace>/tasks/<id>/` are the agent's own product dirs. emploke
  creates them and bakes a starter `AGENTS.md` / `.mcp.json` from the
  catalog; the agent owns everything else inside.
- **Server lifecycle** — `<EMPLOKE_HOME>/runtime.json` (pid + port +
  apiKey) stays a JSON file for ops ergonomics. Port-binding is the
  actual mutex; SQLite's atomic-write would buy nothing here.
- **Logs** — `<EMPLOKE_HOME>/logs/` is rotated JSONL via `pino-roll`.

### Hybrid: when an entity has both metadata and content

`session` and `task` use a **hybrid** pattern: SQLite owns the
queryable metadata; FS owns the human-meaningful content. The
metadata row lives in the per-workspace `workspace.db`; the workdir
directory tree (`<workspace>/sessions/<sid>/...` for session,
`.../tasks/<tid>/` for task) stays a plain directory of agent-produced
files (AGENTS.md, artifacts, captured stderr). The default `delete(id)`
removes only the metadata row (the "archive" mode — matches the
workspace-wide "purge is opt-in" pattern, giving operators a chance
to inspect agent output after a delete); `delete(id, { purge: true })`
additionally removes the workdir AND asks the runtime to wipe its
own per-entity state (Copilot's `<copilotStateDir>/<id>/` etc.) via
`Runtime.deleteState(runtimeSessionId)` — the same verb is used for
both sessions and tasks because the runtime is domain-agnostic, so
a hard delete leaves nothing behind across the layers.

This split keeps the workdir-as-product invariant (`cd` into a session
workdir, find the agent's actual output, grep it, commit it to your
own git history) while moving the metadata into a shape that scales
to thousands of rows under filtering / sorting queries.

### Why no unified persistence service

#32 explored a generic `PersistenceService` (Phase 2 of the proposed
`@emploke/storage`). It was deliberately not built. Each entity's
repository surface is shaped by its own queries:
`WorkspaceRepository.getCurrent()`,
`TaskRepository.list({ statuses, runtime, ... })`,
`CatalogManager.resolveAgent()` (graph). A unified interface would
force these into either an `unknown`-typed lowest common denominator
or a parade of entity-specific extension methods that re-introduce
the per-entity shape it was meant to remove.

The pattern that works: **shared SQLite connection per scope (global
+ per-workspace), per-entity repositories with their own table
ownership and `schema_meta` row.**

## Unified verb conventions

Two verbs are deliberately consistent across every entity:

- **`delete(id, { purge?: boolean })`** — every Manager. Default is
  metadata-only (the repository row is removed; agent-produced files
  under `<workdir>/<entity>/<id>/` are preserved for archival).
  `purge: true` additionally removes the entity's sandbox directory.
  The workspace's `workdir` itself is **never** removed by emploke;
  it's user-owned. REST mirrors: `DELETE
  /api/workspaces/:id/tasks/:tid?purge=1`.
- **`create(...)`** vs **`save(...)`** on repositories — `create` is
  atomic create-or-fail (throws `*IdConflictError` if the id is taken);
  `save` is upsert (last-writer-wins). Managers' `init` paths use
  `create` to close concurrency races; `update` paths use `save`.

When in doubt, copy the pattern from `WorkspaceManager`.

## Wire formats

JSON files on disk are **A1 flat**: `{schemaVersion: N, ...fields}` at
the top level. The FS repository wraps on save and unwraps on read; the
domain type sees no `schemaVersion`. Any future migration adds a new
`schemaVersion` and a per-version branch in the repository's parse
function — domain types and managers stay untouched.

`schemaVersion` mismatches throw a typed `*CorruptedError` with an
upgrade-or-migration hint string; the server maps these to HTTP 500 so
the dashboard can surface the cause without crashing.

## HTTP API URL scheme

Workspace-scoped resources live under
`/api/workspaces/<wsid>/{catalog,sessions,tasks}/...`. The `<wsid>` is
the workspace's opaque UUID — stable for the lifetime of the registry
entry, so dashboard URLs survive workspace renames. There is no global
catalog mount; switching workspace switches the catalog the dashboard
sees.

A `WorkspaceContextCache` lazily mints + retains per-workspace
manager instances behind that URL prefix; cache invalidation happens
on workspace deletion or metadata update.

The server is **loopback-only by default**; non-loopback `EMPLOKE_HOST`
requires `EMPLOKE_API_KEY` (Bearer-token check on every `/api/*`
request) and emploke refuses to start otherwise. A misconfigured
production deploy fails fast.

## Per-workspace layout

```text
<workspace>/
├── workspace.db                 single SQLite per workspace — holds task / session / catalog tables (one row per pkg in schema_meta)
├── sessions/<id>/               agent-baked workdir; `copilot` runs here
│   ├── AGENTS.md                materialised from catalog at create time
│   ├── .mcp.json                merged from agent's MCP deps
│   └── .github/{skills,hooks}/  materialised from catalog
└── tasks/<id>/                  one-shot autonomous dispatch — workdir for agent artifacts
    ├── stderr.log               CLI errors (the runtime owns its event log via readActivity, NOT mirrored here)
    └── ...                      whatever the agent writes
```

Workspace metadata (`name`, `createdAt`, `defaults`) lives in
`<EMPLOKE_HOME>/global.db` keyed by workspace id — there is no
`workspace.json` sidecar. Catalog content (agents/skills/mcps) lives in
the workspace's `workspace.db`, not as loose files; the dashboard /
CLI mutates them via the catalog API.

The conventional sub-paths under `workdir` (`sessions/`, `tasks/`) are
computed by `workspaceLayout(workdir)`, not stored on the `Workspace`
entity.

## How runtimes plug in

A runtime adapts a third-party CLI for emploke. The contract is
**domain-agnostic**: it knows nothing about emploke's `Session` or
`Task` value types — managers (`@emploke/session`, `@emploke/task`)
translate their domain into runtime calls at the call site, keyed
by an opaque `runtimeSessionId` string. The contract lives at
[`packages/runtime/src/types.ts`](../packages/runtime/src/types.ts):

```ts
interface Runtime {
  readonly kind: string;                                              // "copilot", "gemini", ...

  // Interactive (-i)
  provision(workdir, agent, catalog, ctx): Promise<{                  // bake agent into workdir
    runtimeSessionId: string | null;                                  //   pre-allocate? null = discovery-only
  }>;
  buildLaunch(runtimeSessionId, workdir, workspaceDir, opts?):        // produce the exact `cmd args cwd`,
    Promise<LaunchCommand>;                                           //   running per-launch preconditions
                                                                       //   keyed off workspaceDir

  // Non-interactive (-p)
  dispatch?(opts): Promise<RuntimeHandle>;                            // optional: spawn one-shot worker

  // Observability (uniform across modes; keyed by runtimeSessionId)
  readMetadata?(runtimeSessionId):                                    // optional: title / lastActiveAt
    Promise<RuntimeSessionMetadata | null>;
  readActivity?(opts):                                                // optional: parsed timeline,
    Promise<ActivityResult | null>;                                   //   paginated by cursor + limit
  streamActivity?(opts): AsyncIterable<ActivityItem>;                 // optional: live SSE tail

  // Maintenance
  deleteState(runtimeSessionId): Promise<void>;                       // remove CLI's recorded state
}
```

Per-runtime preconditions (e.g. Copilot's interactive mode requires
`workspaceDir` to be in `~/.copilot/config.json` `trustedFolders` to
suppress its folder-trust prompt) are owned inside the adapter and run
lazily inside `buildLaunch`. There is no cross-runtime
"register workspace" hook — different CLIs have wildly different gating
rules and trying to abstract them just leaks one runtime's internals
into the others.

The runtime pulls **content** from the catalog through three streams,
not via on-disk paths:

```ts
catalog.agentEntries(name): AsyncIterable<{relPath, content: Buffer}>
catalog.skillEntries(name): AsyncIterable<{relPath, content: Buffer}>
catalog.getMcpContent(name): Promise<string>
```

`relPath` is always POSIX (`/`) regardless of host OS so consumers can
safely string-prefix. This shape lets a future SQLite-backed catalog
replace the FS repo without changing a line of runtime code — rows
have no on-disk path to give back, but they have content streams just
fine.

## Filesystem contract

Everything emploke writes under `<EMPLOKE_HOME>` (default `~/.emploke`)
and a workspace's `<workdir>/` is **server-internal state**. The layout
described in [`Per-workspace layout`](#per-workspace-layout) above plus
the per-home paths below (file names, JSON shapes, SQLite schemas,
sidecar files) is implementation detail; clients — dashboard, CLI,
future MCP server — interact strictly through the HTTP API and never
read those paths directly. Reading by hand for inspection is fine;
**writes / hand-edits / `rm` by anything other than emploke are
unsupported and may be detected as corruption.**

### Per-home paths

Beyond the per-workspace tree, `<EMPLOKE_HOME>` holds:

| Path | Owner | Notes |
| ---- | ----- | ----- |
| `global.db`        | server               | SQLite — workspace registry (id → workdir + currentId) plus other cross-workspace state. |
| `runtime.json`     | CLI lifecycle        | Written by `emploke start`; pid + port + apiKey of the running server. `chmod 0600` when an apiKey is present. |
| `logs/`            | server               | Rotated server logs (pino-roll). |
| `shared/`          | runtime adapters     | `${globalDir}` placeholder root for MCP specs. |

### Ownership boundaries

The per-workspace layout has three distinct owners — each with a
different "what hand-editing does" story:

- **emploke** owns the SQLite databases (`<EMPLOKE_HOME>/global.db` for
  the workspace registry + cross-workspace state, `<workspace>/workspace.db`
  for everything per-workspace including catalog content) plus their
  `-wal` / `-shm` sidecars. Add or remove catalog entries through
  `emploke catalog ...` or the dashboard so the SQLite index stays
  consistent with the install/sync workflow; do not edit by hand.
- **the agent** owns the contents of `<workspace>/sessions/<id>/` and
  `<workspace>/tasks/<id>/` after emploke creates the directory and
  bakes `AGENTS.md` from the catalog. Files the agent writes,
  captured stderr — agent's responsibility. Deleting an entire
  `<id>/` directory by hand is supported (the next `list` call drops
  the orphan row from the manager's view); editing the baked
  `AGENTS.md` reaches the agent on the next launch but bypasses
  catalog versioning.
- **the runtime adapter** owns its own per-session / per-task state
  outside the workdir entirely (Copilot:
  `~/.copilot/<runtimeSessionId>/`). Emploke never reads it as a
  filesystem path; the typed `Runtime.readMetadata()` /
  `Runtime.readActivity()` / `Runtime.streamActivity()` API surface is
  the only bridge.

### Why the contract matters

This boundary is what gives the storage layer freedom to evolve. Schema
migrations, additional sidecars, JSON → SQLite transitions, even
relocating a file — none of these are breaking changes as long as the
HTTP API surface stays stable. A future runtime that ships its log as
a SQLite row or streams it over a socket fits the same contract
without any change on the emploke side. If you hand-edit a managed
file and break it, that's a `git restore` away (if you're lucky) or a
`rm <file> && emploke restart` away — not a bug report.

## Tech stack

- **TypeScript** (≥ 5.7) with strict + `exactOptionalPropertyTypes`.
- **Node** ≥ 22 (uses native fetch, `node:test` not used — see vitest).
- **pnpm** ≥ 10 workspaces; one `tsconfig.json` per package, downstream
  packages import upstream `.d.ts`.
- **[Hono](https://hono.dev)** for the HTTP server (lightweight, no
  Express baggage; supports streaming responses out of the box).
- **[React](https://react.dev)** + **[Vite](https://vite.dev)** for
  the dashboard (development) → bundled SPA served from the same Hono
  process (production).
- **[Vitest](https://vitest.dev)** for tests; one `vitest.config.ts`
  per package. Tests use `vi.mock` + `vi.spyOn` for module-boundary
  spies.
- **[Biome](https://biomejs.dev)** for lint + format. One config at
  the repo root; CI fails on diff.
- **[esbuild](https://esbuild.github.io)** for the production bundle
  (`pnpm bundle` → `bundle/emploke.js` + `bundle/static/`).
- **[pino](https://getpino.io)** for structured logging — committed
  to as the API surface, not just a transport choice. `Logger` in
  `@emploke/logger` is `pino.Logger`; call sites use pino's native
  `(meta, msg)` form (`logger.info({ userId }, "user logged in")`)
  and reach for pino features (`child(bindings)` for per-request /
  per-component scoping, `redact` for token sanitisation,
  `serializers` for error rendering) directly. Pretty-printed in
  dev, JSON in prod (file destination is always JSON regardless).
  - `silentLogger` is `pino({ level: "silent" })` — the default for
    any optional `logger?` constructor parameter; pino short-circuits
    at the level check so it incurs no allocation cost.
  - Test seam: `import { captureLogger } from "@emploke/logger/testing"`
    returns `{ logger, entries }` for tests that need to assert on
    structured log output.

## Testing posture

- Every package has its own vitest suite. `pnpm test` runs them all.
- Integration tests live in `packages/<pkg>/test/integration/` and
  use real subprocess spawning where applicable. They run on the same
  CI matrix (Linux / macOS / Windows / Node 22).
- The **InMemory repository per entity** is the preferred test seam.
  Reach for `mkdtemp` + the FS repo only when the test must observe
  on-disk behavior (atomicity, lock recovery, scan order).
- Vitest's `vi.mock` pattern is used to spy on module imports —
  see `packages/catalog/test/fs-repositories.test.ts` for the
  canonical example (regression-test that production code goes through
  the atomic-write seam).

## Coding conventions

- **No `any` outside test stubs.** The repo runs strict TypeScript
  with `exactOptionalPropertyTypes`; if a value is "optional", the
  type is `T | undefined` and the field is conditionally spread, not
  assigned `undefined` directly.
- **Errors are typed.** Every package defines its own error hierarchy
  (`WorkspaceError`, `CatalogError`, `RuntimeError`, …); the server
  maps them to HTTP status codes via `instanceof` checks. Throwing a
  `new Error(...)` from a manager is a smell.
- **Comments explain *why*, not *what*.** A regex is self-explanatory;
  the choice to use `Number.parseInt` over `+` because the input might
  be `"0x10"` is not. Lean toward more comments at decision points,
  fewer at mechanical steps.
- **Atomic writes go through `@emploke/fs`.** Plain `writeFile`
  to a long-lived file is a code-review red flag.

## Adding a new runtime

To add e.g. a Gemini adapter:

1. Implement the `Runtime` interface in `packages/runtime/src/gemini/`
   following the Copilot impl as a reference. Pre-allocating runtimes
   (CLI accepts `--resume=<arbitrary-uuid>`) return a fresh UUID from
   `provision`; discovery-only runtimes return `null` and rely on a
   per-runtime discovery hook to learn the id later.
2. Implement `dispatch` if the CLI supports unattended scripting.
   Pull agent + skill content from the supplied `catalog` argument
   via `agentEntries` / `skillEntries`; write into the supplied
   `opts.workdir`. Never resolve catalog paths from the resolve result.
3. Implement `readActivity` (and ideally `streamActivity`) to read
   your runtime's per-conversation log end-to-end (find file → read →
   parse → derive headline) and return runtime-neutral `ActivityItem[]`
   plus `result`. Pagination via `cursor` + `limit` is mandatory for
   `readActivity`; `streamActivity` honours `opts.signal` for
   cleanup. Implement `readMetadata` if the CLI surfaces a session-
   level display title. The dashboard / CLI / future MCP renders
   `ActivityItem`s without ever seeing your log format or path.
4. Register the runtime in the `RuntimeRegistry` at
   `packages/server/src/runtime-registry.ts`.

The dashboard adapts automatically — runtimes are listed via
`/api/runtimes` and the create-session / dispatch-task forms pick
them up.

## Where to look next

- **The paper:
  [*What we believe about agentic systems*](https://langsensei.github.io/emploke/)** —
  the paradigm emploke implements. Three beliefs, three commitments,
  one extension surface. Read this before proposing architectural
  changes that touch the boundary between code and AI.
- Per-package READMEs — public API surface for each entity:
  - [`@emploke/workspace`](../packages/workspace/README.md)
  - [`@emploke/catalog`](../packages/catalog/README.md)
  - [`@emploke/session`](../packages/session/README.md)
  - [`@emploke/task`](../packages/task/README.md)
  - [`@emploke/runtime`](../packages/runtime/README.md)
  - [`@emploke/server`](../packages/server/README.md)
- [`docs/RELEASING.md`](./RELEASING.md) — maintainer release procedure.

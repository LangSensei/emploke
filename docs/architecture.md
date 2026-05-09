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
   The `schemaVersion` lives only inside the FS repository's wire format
   (the `task.json` / `workspace.json` on disk wrap the value in
   `{schemaVersion: N, ...fields}`); the manager strips it on read.
2. **Repositories are bytes in / bytes out.** They never parse
   frontmatter, build dependency graphs, or maintain caches — those are
   manager concerns. The repository's job is "given an id, return the
   stored value (or null)."
3. **InMemory implementations exist for tests.** Every entity package
   exports one at `@emploke/<pkg>/testing`. Test code consumes the same
   manager class as production but injects the in-memory repo — fast,
   no `mkdtemp` ritual, and crucially the InMemory impl validates ids
   the same way the FS impl does so tests can't pass with malformed
   inputs that production would reject.

## `@emploke/fs`: the atomic IO seam

Every FS-touching operation in the repo goes through one of four
primitives in [`packages/fs`](../packages/fs):

| Primitive               | What it guarantees                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `writeFileAtomic`       | Write-temp + rename. Survives mid-write crashes; readers see old or new bytes, never partial. EPERM/EACCES retry on Windows.  |
| `writeJsonAtomic`       | `writeFileAtomic` + `JSON.stringify` with trailing newline.                                                                   |
| `readJson`              | `readFile` + `JSON.parse` with a 10 MB cap (DoS guard); double-checked post-read to defeat stat/read TOCTOU races.            |
| `withFileLock`          | Advisory lock backed by an `O_EXCL` lockfile, with PID-aware stale recovery (stuck PID → wait; dead PID → steal).             |

These are the **only** allowed paths to durable state in the repo. A
catalog `write()`, a workspace registry mutation, a task.json save —
all flow through these. CI failures and production incidents disappear
when an entity rewrite forgets to use them; the parameterised
regression test in `packages/catalog/test/fs-repositories.test.ts`
spies on `writeFileAtomic` to keep that from happening again.

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
├── workspace.json               { schemaVersion, name, createdAt, defaults? }
├── catalog/
│   ├── agents/<name>/AGENTS.md  + arbitrary sibling files (templates, scripts)
│   ├── skills/<name>/SKILL.md   + arbitrary sibling files (incl. hooks/copilot/)
│   └── mcps/<name>.json
├── sessions/<id>/               agent-baked workdir; `copilot` runs here
│   ├── AGENTS.md                materialised from catalog at create time
│   ├── .mcp.json                merged from agent's MCP deps
│   └── .github/{skills,hooks}/  materialised from catalog
├── tasks/<id>/                  one-shot autonomous dispatch
│   ├── task.json                { schemaVersion, ...task fields }
│   ├── session/                 → junction → runtime's per-task state dir
│   ├── stderr.log               CLI errors before session dir exists
│   └── ...                      whatever the agent writes
├── workflows/<id>/              placeholder
└── logs/                        placeholder
```

The conventional sub-paths are computed by `workspaceLayout(workdir)`,
not stored on the `Workspace` value type. A SQLite-backed repository
would persist no on-disk layout, but the manager would still call
`workspaceLayout(...)` to know where to spawn agents.

## How runtimes plug in

A runtime adapts a third-party CLI for emploke. The contract lives at
[`packages/runtime/src/types.ts`](../packages/runtime/src/types.ts):

```ts
interface Runtime {
  readonly kind: string;                                  // "copilot", "gemini", ...

  provision(workdir, agent, catalog): Promise<{          // bake agent into workdir
    runtimeSessionId: string | null;                      //   pre-allocate? null = discovery-only
  }>;

  refresh(session): Promise<{                             // poll the CLI for activity
    lastActiveAt: string;
    preview: string | null;
    runtimeSessionId: string;
  } | null>;

  buildLaunch(session, workspaceDir): Promise<LaunchCommand>;  // produce the exact `cmd args cwd`,
                                                                //   optionally running per-launch
                                                                //   preconditions keyed off workspaceDir
  deleteState(session): Promise<void>;                    // remove CLI's per-session state
  dispatchTask?(opts): Promise<TaskHandle>;               // optional: one-shot non-interactive
  taskEventsPath?(taskWorkdir): string | null;            // optional: where to find task events
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
- **[pino](https://getpino.io)** for structured logging; threaded
  through every manager. Pretty-printed in dev, JSON in prod.

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
   `provision`; discovery-only runtimes return `null` and rely on
   `refresh` to learn the id later.
2. Implement `dispatchTask` if the CLI supports unattended scripting.
   Pull agent + skill content from the supplied `catalog` argument
   via `agentEntries` / `skillEntries`; write into the supplied
   `taskDir`. Never resolve catalog paths from the resolve result.
3. Implement `taskEventsPath` to expose where the CLI writes its
   per-session event log; the dashboard streams the bytes opaquely.
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

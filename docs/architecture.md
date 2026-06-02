# Architecture

This document is for **contributors** — people writing code in this repo
or adding a new runtime adapter. End-user docs live in the root
[`README.md`](../README.md). The conceptual rationale — *why* emploke is
shaped the way it is — lives in the paper
[*What we believe about agentic systems*](https://langsensei.github.io/emploke/).

Alongside the TypeScript packages, the repo ships a
[`first-party/`](../first-party/) subtree of bundled agents and skills
under `scope: emploke`. These entries depend on internals defined here
(catalog schema, CLI surface, runtime contracts) tightly enough that
they version-bump and PR in lock-step with the packages. They are
distinct from the community catalog at
[emploke-marketplace](https://github.com/LangSensei/emploke-marketplace),
which uses `scope: langsensei`.

## Tier model

emploke's packages organise around a 5-tier model. Each tier number
describes *what kind of thing* a package is — not who imports whom.
Dependency-direction invariants (port vs direct import, allowed
imports per tier) are a **separate axis** with its own rules, **TBD
in a follow-up doc**.

| Tier      | Name        | Packages                                            | Conceptual role                                                                         |
| --------- | ----------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **T0**    | Foundations | `catalog`, `runtime`, `schedule`, `terminal`, `workspace` | Who / Where / When / Scope + leaf infrastructure — irreducible primitives                |
| **T1**    | Modes       | `session`, `task`                                   | Interactive vs Headless execution mode (= Agent × Runtime × {mode})                     |
| **T2**    | Application | `contracts` (wire types), `api` (orchestration)     | Two siblings: cross-pkg wire contracts + composition of T0/T1 into business capabilities |
| **T3**    | Host        | `server`                                            | HTTP transport that exposes T2 capabilities over the wire                               |
| **T_top** | Surfaces    | `dashboard`, `cli`                                  | Platform-specific UI on top of T3                                                       |

`workflow` is intentionally excluded — deferred, not yet implemented.

### Tier philosophy

**Pure conceptual classification.** A tier number describes *what
kind of thing* a package is, not who imports whom. Two packages can
sit in the same tier even if one imports the other. Whether a
dependency flows via direct import, via a declared port, or via a
wire format is a separate axis (see "Dependency invariants" — TBD).

**Each tier answers a different question.**

- T0 — what irreducible primitives does an agentic system need?
  (Who runs · Where to run · When to run · within what Scope)
- T1 — in what *mode* is the work running? (Interactive `session`
  vs Headless `task`)
- T2 — what can the system *do*, and how is that spelled? Split
  across two siblings:
  - `contracts` — the *what is on the wire*: route catalog, request /
    response DTO shapes, leaf path helpers (`EMPLOKE_HOME`,
    `runtime.json`). Pure types + side-effect-free constants. The
    universal surface that crosses the public boundary; consumed by
    `server`, `dashboard`, `cli`, and downstream HTTP / IPC clients.
  - `api` — the *how it's built*: `composeApplication`,
    `WorkspaceContext`, per-workspace registries, schedule-task
    wiring. Node-only orchestration that assembles T0/T1 services to
    implement the contracts. Consumed by `server`. Re-exports the
    contracts barrel as a convenience for the in-process server
    composition root that needs both layers in one import site.
- T3 — how do remote clients invoke T2? `server` is a thin HTTP
  binding.
- T_top — how does a human (or another agent) interact?

**Visibility rule.** The fence is **partial and partly
machine-enforced**:

- **Strictly enforced** (lint test
  `packages/e2e/test/architecture/tier-invisibility.test.ts`):
  `@emploke/dashboard` source + tests may only reference
  `@emploke/contracts`; `@emploke/cli` may only reference
  `@emploke/contracts` and `@emploke/server`. Pkg-manifest deps are
  audited alongside source imports — a dangling devDep that hoists
  an orchestration pkg into the consumer's `node_modules` is
  flagged even when no source file imports it.
- **Convention only** (not machine-enforced): T0/T1 packages SHOULD
  NOT be imported by T3 or T_top (server or other surfaces).
  `server` may import T0/T1 directly today; the dashboard / cli
  fence above is the strict half. `@emploke/api` re-exports the
  contracts barrel for server's convenience.

The fenced consumers' allowed edges:

```text
                       ┌──────────────────────────────┐
@emploke/dashboard ──▶ │ @emploke/contracts (T2)      │
@emploke/cli       ──▶ │   wire types + path helpers  │
                       └──────────────────────────────┘
@emploke/cli       ──▶ @emploke/server  (the cli binary IS the
                                         server bundle; `emploke
                                         serve` boots in-process,
                                         `emploke start` spawns it)
```

**`api` is the orchestration composition root.** New cross-cutting
features land in `api` (or split into `contracts` if they are
wire-only); transport (`server`) and UI (`dashboard` / `cli`)
stay thin. The leaf infrastructure pkgs (`terminal` and the runtime
adapters) carry no orchestration of their own — `api` is the only
in-process consumer that wires them together.

## Layering

The repo is one [pnpm workspace](https://pnpm.io/workspaces) of
packages with a strict layering. Higher layers may depend on lower
layers; never the reverse. The 5-tier model (see [§ Tier model](#tier-model))
gives each box a name.

```text
                ┌────────────────────────┐
                │ @emploke/dashboard     │  React + Vite SPA (T_top)
                └───────────┬────────────┘
                            │ HTTP /api/*      ┌────────────────┐
                            │           ┌─────▶│ @emploke/      │
                            │           │      │   contracts    │
                ┌───────────▼────────────┤      │  (T2 — wire    │
                │ @emploke/cli           │      │   types only)  │
                │ (lifecycle commands)   │      └───────▲────────┘
                └───────────┬────────────┘              │
                            │ HTTP /api/*               │  re-exports
                ┌───────────▼────────────┐              │
                │ @emploke/server        │              │
                │ (routes + middleware)  │  T3 Host     │
                └───────────▲────────────┘              │
                            │  composes T0/T1           │
                ┌───────────┴────────────┐    ┌─────────┴──────┐
                │ @emploke/api           │───▶│ @emploke/      │
                │ T2 Application:        │    │  terminal      │
                │  composeApplication    │    │ (spawn         │
                │  + WorkspaceContext    │    │  launcher)     │
                │  registry              │    └────────────────┘
                └───────────▲────────────┘
                            │
   ┌───────────┬────────────┼────────────┬────────────────┐
   │           │            │            │                │
┌──┴──┐  ┌─────┴─────┐ ┌────┴────┐ ┌─────┴─────┐  ┌───────┴────┐
│task │  │ session   │ │ catalog │ │ workspace │  │  runtime   │
└──▲──┘  └─────▲─────┘ └─────────┘ └───────────┘  └────────────┘
   T1          T1            T0          T0              T0
   │           │
   └───────────┴── runtime adapters consumed by task + session
```

`@emploke/contracts` is the strict-isolation surface for the fenced
consumers: pure types + side-effect-free path / route constants,
zero orchestration code. `@emploke/api` depends on it and
re-exports the whole barrel, so the in-process server boot path can
import "both halves" from a single specifier (`@emploke/api`).
Dashboard and CLI MUST go through `@emploke/contracts` directly —
the structural fence is enforced by
`packages/e2e/test/architecture/tier-invisibility.test.ts`.

`@emploke/terminal` is consumed **only by `@emploke/api`** at
runtime — specifically by `composeApplication`, which value-imports
`spawnTerminal` and threads it as an injected `SpawnFn` through
`composeSessionModule` into `SessionService`. The actual
"build the `LaunchCommand` and hand it to the spawner" step lives
inside `SessionService.spawnInteractive(sid, opts)` (issue #276);
`api`'s job is wiring, not invocation. Entity packages don't see
`@emploke/terminal` — `@emploke/session` consumes the spawner via
the structurally-typed `SpawnFn` port (`(cmd: LaunchCommand) =>
Promise<{ launcher: string }>`) without importing terminal at all,
so the cross-domain architecture fence
(`packages/e2e/test/architecture/inter-service-imports.test.ts`)
stays intact. `@emploke/runtime` produces `LaunchCommand` values
but does not spawn terminals. The dep direction is asymmetric and
deliberate: `terminal` declares its own `LaunchCommand` shape as a
**consumer port** (see `packages/terminal/src/types.ts`) and has
zero workspace deps; `runtime`'s `LaunchCommand` is the
producer-side definition; TypeScript's structural typing wires the
two together at the `composeApplication` call site without forcing
either pkg to depend on the other.

The entity packages (`workspace`, `session`, `task`, `catalog`) sit at
the same level — they don't depend on each other directly. Composition
happens at the [`@emploke/api`](../packages/api) layer: api holds
one `WorkspaceService` process-wide and lazily mints per-workspace
`{catalog, sessions, tasks}` bundles behind a
`WorkspaceRuntimeCache`. The server depends on api, not on the
entity pkgs directly. `runtime` is consumed by `session` + `task` to
spawn agents.

## Service + repository pattern

Every entity package follows the same shape: a single
**`<Entity>Service`** class that owns reads + writes, backed by a
package-private **Drizzle repository** that the service constructs.
Tests open the service against `dbFile: ":memory:"` via the package's
`composeXxxModule` helper, so the schema goes through the real
drizzle-kit migrator on every test boot.

### Per-package src layout

```
packages/<pkg>/src/
  schema.ts                 Drizzle table def + `*Row` / `New*Row` types (package-private)
  <entity>-entity.ts        `<Entity>Entity` — pkg-owned domain shape; interface or class
  <entity>-repository.ts    `<Entity>Repository` — Drizzle CRUD; returns Entity
  <entity>-service.ts       `<Entity>Service` — orchestration; returns DTO
  types.ts                  bare-noun DTO (`Workspace`, `Session`, ...) + opts shapes
  errors.ts                 typed error classes
  validate.ts               id regex + zod input schemas
  compose.ts                `compose<Entity>Module({ dbFile })` composition root
  testing.ts                in-memory test fixture (via `/testing` subpath)
  index.ts                  public barrel
drizzle/                    generated SQL migrations (committed)
drizzle.config.ts           drizzle-kit codegen config
```

### The three layers

emploke uses an **explicit 3-layer split** (Row / Entity / DTO) across
every entity pkg. The pkg-template enforces it; see
[`docs/pkg-template.md`](./pkg-template.md) for the full rationale.

| Layer | Where | Suffix | Visibility | Role |
|---|---|---|---|---|
| **Row** | `schema.ts` | `*Row` | pkg-private | Drizzle `$inferSelect` shape; tracks the SQLite table |
| **Entity** | `<entity>-entity.ts` | `*Entity` | pkg-private (NOT re-exported from `index.ts`) | Pkg-owned domain shape; `interface` for anemic BCs, `class` for rich (state machine / invariants) |
| **DTO** | `types.ts` | bare noun (no suffix) | exported from `index.ts` | Wire shape; what `<Entity>Service` returns; stable contract for HTTP / CLI / other pkgs |

Repository public methods return **Entity**. Service public methods
return **DTO**. The row → entity boundary lives inside the repository
file; the entity → DTO boundary lives inside the service file. When
either projection is structurally trivial it's an inline TypeScript
assignment (no helper function); when it's non-trivial — composite
sources, normalisation, async fetches — it grows into a module-private
helper at the same boundary.

```ts
// e.g. packages/workspace/src/workspace-service.ts
export class WorkspaceService {
  // Reads — service projects Entity → DTO inline (1-line normalisation).
  getById(id: string): Promise<Workspace | null>;
  list(): Promise<Workspace[]>;
  getLastOpened(): Promise<Workspace | null>;
  getLastOpenedId(): Promise<string | null>;

  // Writes — Stripe-style hybrid: primary key positional, options in bag.
  register(input: { id, workspaceDir, name }): Promise<{ id: string }>;
  open(id: string): Promise<void>;
  rename(id: string, opts: { newName: string }): Promise<void>;
  unregister(id: string, opts?: { purge?: boolean }): Promise<void>;
}
```

### Three properties of the pattern

1. **Repositories are persistence-only.** They never parse
   frontmatter, build dependency graphs, mkdir, spawn subprocesses,
   or call other pkgs. The repository's job is "given an id, return
   the stored `Entity` (or undefined)." Side effects, validation,
   cross-pkg coordination, FSM transitions all live in the service.
2. **`*Row` never leaves the repository.** No `export * as schema`
   from `index.ts`; the Drizzle inferred type is implementation
   detail. Swapping ORMs only touches `schema.ts` +
   `<entity>-repository.ts`.
3. **`*Entity` classes are pkg-private.** Rich BCs (catalog/task)
   keep their FSM class internal; the public projection is the
   bare-noun DTO. Anemic BCs (workspace/session) use a plain
   `interface` for Entity instead of a class.



## Atomic IO seam

Out-of-band JSON files (the CLI lifecycle `runtime.json`, agent-baked
`AGENTS.md` / `.mcp.json`) are written via
[`write-file-atomic`](https://github.com/npm/write-file-atomic) —
write-temp + rename, so readers see old or new bytes, never partial.
Use it for any long-lived JSON / Markdown file consumed by an
external reader. `proper-lockfile` covers the cases that need a
PID-aware advisory lock (the runtime adapter's per-session state
preflight).

Long-lived structured state lives in SQLite (`global.db`,
`workspace.db`) and gets the equivalent guarantees from WAL mode +
transactions — no separate atomic-write layer needed there.

## Backend selection: when SQLite

emploke deliberately keeps its persistence backend simple and consistent.
Today **every entity is SQLite-backed**, but the DBs are split by
**scope** (where the data lives in the lifetime hierarchy), not by
entity:

- **`<EMPLOKE_HOME>/global.db`** — workspace registry + cross-workspace
  state (current-workspace pointer, future audit logs, etc).
- **`<workspace>/workspace.db`** — every per-workspace entity (catalog,
  session, task, future workflow). One connection serves them all,
  shared via DI from `WorkspaceRuntime` (in `@emploke/api`).

Each pkg owns its own tables inside the shared DB. Schema evolution
goes through **drizzle-kit** — `pnpm --filter @emploke/<pkg>
db:generate` produces an SQL file under `<pkg>/drizzle/`; the
in-pkg migrator at compose time applies them and records the
applied filename in `__drizzle_migrations`. There is no
cross-package coordinator any more — each pkg's table set is
managed by its own drizzle-kit setup. The service holds no
in-memory snapshot; SQLite is the source of truth and reads run in
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
- **Server lifecycle** — `<EMPLOKE_HOME>/runtime.json` (pid + port)
  stays a JSON file for ops ergonomics. Port-binding is the
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
`WorkspaceService.getLastOpened()`,
`TaskService.list({ statuses, runtime, ... })`,
`CatalogService.resolveAgent()` (graph). A unified interface would
force these into either an `unknown`-typed lowest common denominator
or a parade of entity-specific extension methods that re-introduce
the per-entity shape it was meant to remove.

The pattern that works: **shared SQLite connection per scope (global
+ per-workspace), per-entity drizzle-managed tables.**

## Unified verb conventions

- **`delete(id, { purge?: boolean })`** — every Service. Default is
  metadata-only (the repository row is removed; agent-produced files
  under `<workdir>/<entity>/<id>/` are preserved for archival).
  `purge: true` additionally removes the entity's sandbox directory.
  The workspace's `workdir` itself is **never** removed by emploke;
  it's user-owned. REST mirrors: `DELETE
  /api/workspaces/:id/tasks/:tid?purge=1`.
- **Stripe-style hybrid params** — primary key (id) positional;
  flags / options in a single trailing options bag
  (`service.rename(id, { newName })`,
  `service.unregister(id, { purge })`). `register`-style creates
  that have no canonical positional key take a single options bag
  (`service.register({ id, workspaceDir, name })`). The shape
  matches Stripe's published API style; see
  [`docs/pkg-template.md`](./pkg-template.md) for the rationale.

When in doubt, copy the pattern from `WorkspaceService`.

## Wire formats

Persisted state lives in SQLite — the schema is the wire format. Add
a column or backfill via `pnpm --filter @emploke/<pkg> db:generate`
+ the generated migration; drizzle-kit produces forward-only SQL
that the in-pkg migrator applies once at compose time.

Out-of-band JSON files (the CLI's `runtime.json`, the agent-baked
`AGENTS.md` / `.mcp.json`) are written `{schema: N, ...fields}` at
the top level. Bump `schema` on breaking changes; reject mismatches
at read time with a typed `*CorruptedError` so the dashboard can
surface the cause without crashing.

## HTTP API URL scheme

Workspace-scoped resources live under
`/api/workspaces/<wsid>/{catalog,sessions,tasks}/...`. The `<wsid>` is
the workspace's opaque UUID — stable for the lifetime of the registry
entry, so dashboard URLs survive workspace renames. There is no global
catalog mount; switching workspace switches the catalog the dashboard
sees.

A `WorkspaceRuntimeCache` (in `@emploke/api`) lazily mints + retains
per-workspace `{catalog, sessions, tasks}` bundles behind that URL
prefix; cache invalidation happens on workspace deletion or rename.
An explicit `POST /api/workspaces/:id/reload` is also available for
operator-driven reload (refused with HTTP 409 +
`code=WorkspaceHasLiveTasksError` when the workspace still has live
task subprocesses).

The server is **loopback-only**: it refuses to bind to anything other
than `127.0.0.1` / `::1`. emploke ships no built-in auth, on the
principle that "rolling our own" is rarely the right answer for a
single-user local-first dashboard. For remote access, expose the
loopback socket through a layer designed for auth (SSH port-forward,
reverse proxy with mTLS / OIDC, mesh VPN with peer auth such as
Tailscale). A misconfigured non-loopback bind fails fast at startup.

## Per-workspace layout

```text
<workspace>/
├── workspace.db                 single SQLite per workspace — holds task / session / catalog tables (one row per pkg in schema_meta)
├── sessions/<id>/               agent-baked workdir; `copilot` runs here
│   ├── AGENTS.md                materialised from catalog at create time
│   ├── .mcp.json                merged from agent's MCP deps
│   └── .github/{skills,hooks}/  materialised from catalog
└── tasks/<id>/                  one-shot autonomous dispatch — workdir for agent artifacts
    ├── AGENTS.md                materialised from catalog at create time (runtime.provision)
    ├── .mcp.json                merged from agent's MCP deps (runtime.provision)
    ├── TASK.md                  user-supplied brief + optional details (TaskService.dispatch writes `# <brief>\n` or `# <brief>\n\n<details>\n`)
    ├── temp/                    agent scratch (created empty; not surfaced to the user)
    ├── artifact/                user-visible task output (created empty; agent-managed)
    ├── stderr.log               CLI errors (the runtime owns its event log via readActivity, NOT mirrored here)
    └── ...                      whatever the agent writes
```

The `TASK.md` + `temp/` + `artifact/` triple is the Task layer's
**file contract** with the agent (issue #109). The agent receives a
short fixed framing prompt via the spawn argv that points it at this
layout; the user-supplied `brief` (+ optional `details`) is **not**
passed via argv — they live byte-for-byte in `TASK.md` (rendered as
`# <brief>\n\n<details>\n`, or just `# <brief>\n` when details is
absent). This eliminates a class of silent-degradation bugs on
Windows where any LF in user-supplied prompt bytes truncated
`cmd.exe`'s parsing of the spawn argv, silently dropping
`--output-format json` / `--resume` / etc. The framing constants
live in `packages/task/src/framing.ts` and are selected per runtime
kind; today only `copilot` is registered.

`temp/` and `artifact/` are agent-managed after creation; emploke
does not prune them. Future work could surface `artifact/` in the
dashboard as the canonical "task output" location.

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
    Promise<ActivityResult | null>;                                   //   tail-first; before/after/limit
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

## Runtime env contract — vars exposed to spawned subprocesses

emploke spawns the third-party CLI (Copilot today, Gemini / Claude
tomorrow) as a child process for every task / interactive session
launch. The child inherits the server's `process.env` plus a fixed
set of `EMPLOKE_*` variables that emploke contributes itself. This is
the **public contract** for what an agent / skill / sub-shell can
rely on; everything else in the env is "best effort, host-dependent".

| Variable | Type | When set | Meaning |
| -------- | ---- | -------- | ------- |
| `EMPLOKE_SERVER`        | URL string | always | `http://<host>:<port>` the server is listening on. `0.0.0.0` / `::` are rewritten to `127.0.0.1` so the child can dial loopback. emploke binds loopback-only (no auth layer); see "Deliberately not exposed". |
| `EMPLOKE_SHARED_DIR`    | abs path   | always | `<EMPLOKE_HOME>/shared` — the canonical machine-shared writable directory. Same path the runtime exposes to MCP specs as `${sharedDir}`. Pick this for state shared across workspaces (a single playwright login, a model cache). |
| `EMPLOKE_WORKSPACE`     | UUID       | always (per run) | Workspace id (routing key for the HTTP API; `emploke ... --workspace <id>` accepts it). |
| `EMPLOKE_WORKSPACE_DIR` | abs path   | always (per run) | Workspace root on disk. Same path the runtime exposes to MCP specs as `${workspaceDir}`. Pick this for state private to one workspace. |
| `EMPLOKE_WORK_KIND`     | `task` \| `session` | always (per run) | Discriminator for the run that's about to start. |
| `EMPLOKE_WORK_ID`       | string     | always (per run) | This run's id (e.g. `20260514-abc12345`). Same value the dashboard / CLI uses as the URL key. |
| `EMPLOKE_WORK_DIR`      | abs path   | always (per run) | This run's workdir on disk (`<workspace>/tasks/<id>/` for tasks, `<workspace>/sessions/<id>/` for sessions). Same value as the spawned process's `cwd`. |

### Deliberately not exposed

- **`EMPLOKE_HOME`** in the **task / headless** path: agents that
  run inside `emploke task dispatch` see
  `process.env.EMPLOKE_HOME === undefined` even though the server
  itself uses it to find `global.db` / `runtime.json` / `logs/`.
  Server bootstrap passes `SUBPROCESS_ENV_SCRUB_KEYS = ["EMPLOKE_HOME"]`
  to `CopilotRuntime`; the runtime's `launchHeadless` translates the
  list into `undefined` overrides that `mergeEnv` (in
  `launch-headless.ts`) interprets as "delete this key from the
  inherited parent env." Rationale: AI-agent tasks should never touch
  the service-internal directory tree; the only piece they
  legitimately need is `EMPLOKE_SHARED_DIR` and that's exposed
  separately.
- **`EMPLOKE_HOME`** in **interactive session launches**: the user is
  driving a terminal they own, the shell already has `EMPLOKE_HOME`
  set if they care, and the launch command path doesn't override it.
  Scrub keys are NOT honoured on this path — interactive shells
  inherit the parent env wholesale and `cmd /k` / pwsh `$env:`
  prefixes can only SET values, not unset them. Treat
  `EMPLOKE_HOME` as ambient host state, not a session contract.
- **Other shell state**: `cwd`, `PATH`, terminal env, and so on are
  inherited from the server process verbatim. Agents and skills
  that need any of these should declare them in their own
  documentation; emploke only guarantees the table above.
- **Auth credentials**: there is no `EMPLOKE_API_KEY` (or analogue).
  emploke ships no auth layer — the server refuses to bind anywhere
  but loopback (`assertBindIsSafe` rejects non-loopback hosts at
  startup). Remote access is delegated to a system-level layer
  designed for it (SSH port-forward, reverse proxy with mTLS / OIDC,
  mesh VPN with peer auth). Children reach the server purely by
  dialing `EMPLOKE_SERVER` from the same host; no token threading
  through subprocess env, no SSE auth gap.

### Why these specific variables

The contract exists to solve the **fresh-shell problem** that
surfaces when AI-agent harnesses (Copilot CLI, Claude, …) run each
tool call in a brand-new shell. Per-shell `export
EMPLOKE_WORKSPACE=...` doesn't survive between calls; the agent
either has to re-export every call (forgettable, error-prone) or
pass `--workspace <id>` on every command (verbose, easy to typo
across two workspaces). Plumbing the identity through the very
binary the agent shells out to (`emploke task dispatch`) means
subsequent `emploke ...` calls inside the resulting subprocess
inherit the identity automatically — no setup step, no chance of
cross-workspace bleed because the agent rebuilt its env mid-
conversation.

### What downstream code should do with it

Skills and agents that need a workspace-private path should read
`EMPLOKE_WORKSPACE_DIR`, never derive it from `cwd` (which is
`EMPLOKE_WORK_DIR`, two levels under `EMPLOKE_WORKSPACE_DIR`).
Skills and agents that need a machine-shared path should read
`EMPLOKE_SHARED_DIR`. The variables are stable across emploke's
internal layout changes — even if the on-disk shape moves, the env
names stay.

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
| `runtime.json`     | CLI lifecycle        | Written by `emploke start`; pid + port of the running server. |
| `logs/`            | server               | Rotated server logs (pino-roll). |
| `shared/`          | runtime adapters     | `${sharedDir}` placeholder root for MCP specs. |

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
  to as the API surface, not just a transport choice. Every pkg
  takes an optional `logger?: pino.Logger` constructor parameter
  and reaches for pino features (`child(bindings)` for per-request /
  per-component scoping, `redact` for token sanitisation,
  `serializers` for error rendering) directly. Pretty-printed in
  dev, JSON in prod (file destination is always JSON regardless).
  - `silentLogger` is `pino({ level: "silent" })` — the default for
    any optional `logger?` constructor parameter; pino short-circuits
    at the level check so it incurs no allocation cost.
  - Test seam: tests that need to assert on structured log output
    construct a per-test `captureLogger` via pino's
    [`destination`](https://getpino.io/#/docs/api?id=destination)
    API (canonical impl at `packages/server/test/_capture-logger.ts`
    is the simplest example).

## Testing posture

- Every package has its own vitest suite. `pnpm test` runs them all.
- Integration tests live in `packages/<pkg>/test/integration/` and
  use real subprocess spawning where applicable. They run on the same
  CI matrix (Linux / macOS / Windows / Node 22).
- The preferred test seam is **`compose<Entity>Module({ dbFile:
  ":memory:" })`**: opens an in-memory SQLite, runs the real
  drizzle-kit migrations, returns the real service. No mocks of
  the persistence layer; tests assert against actual database
  behaviour (constraint violations, ordering, joins).
- Vitest's `vi.mock` pattern is used to spy on module imports
  when a side-effect needs verification (e.g. confirming the
  service routes a write through the atomic-write helper rather
  than `fs.writeFile` directly).
- Vitest runs in `forks` pool across every pkg. better-sqlite3's
  native binding segfaults on worker-thread teardown on Windows;
  forks isolate per-file with a separate process so the segfault
  becomes a localised failure instead of a workspace-wide outage.

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
- **Atomic writes** for out-of-band JSON files go through
  [`write-file-atomic`](https://github.com/npm/write-file-atomic).
  Plain `writeFile` to a long-lived file is a code-review red flag.

## Adding a new runtime

To add e.g. a Gemini adapter:

1. Implement the `Runtime` interface in `packages/runtime/src/gemini/`
   following the Copilot impl as a reference. Pre-allocating runtimes
   (CLI accepts `--session-id=<arbitrary-uuid>` or equivalent) return
   a fresh UUID from `provision`; discovery-only runtimes return
   `null` and rely on a per-runtime discovery hook to learn the id
   later.
2. Implement `dispatch` if the CLI supports unattended scripting.
   Pull agent + skill content from the supplied `catalog` argument
   via `agentEntries` / `skillEntries`; write into the supplied
   `opts.workdir`. Never resolve catalog paths from the resolve result.
3. Implement `readActivity` (and ideally `streamActivity`) to read
   your runtime's per-conversation log end-to-end (find file → read →
   parse → derive headline) and return runtime-neutral `ActivityItem[]`
   plus `result`. Tail-first pagination via `before` / `after` /
   `limit` is mandatory for `readActivity` (omit both directional
   params for the latest `limit` items — what GUI consumers want on
   first load); `streamActivity` honours `opts.signal` for
   cleanup. Implement `readMetadata` if the CLI surfaces a session-
   level display title. The dashboard / CLI / future MCP renders
   `ActivityItem`s without ever seeing your log format or path.
4. Register the runtime in the `RuntimeRegistry` instantiated at
   `packages/server/src/index.ts`.

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
  - [`@emploke/api`](../packages/api/README.md)
  - [`@emploke/server`](../packages/server/README.md)
- [`docs/RELEASING.md`](./RELEASING.md) — maintainer release procedure.

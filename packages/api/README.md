# @emploke/api

The **T2 Application layer (orchestration)** — emploke's composition
root that wires T0 / T1 packages (`workspace`, `catalog`, `session`,
`task`, `runtime`, `schedule`) into per-workspace runtime contexts.
Cross-package wire contracts (HTTP route catalog, request / response
DTOs, out-of-band IPC files, `EMPLOKE_HOME` resolution) live in the
sibling T2 package `@emploke/contracts`; `@emploke/api` re-exports
the whole `@emploke/contracts` barrel so the in-process server boot
path (`@emploke/server`) imports both halves from a single
specifier. Pairs with `@emploke/server` (HTTP transport) and the
surfaces (`@emploke/terminal`, `@emploke/dashboard`,
`@emploke/cli`).

`@emploke/dashboard` and `@emploke/cli` must NOT import from
`@emploke/api` — they go directly through `@emploke/contracts` (the
structural fence is enforced by
`packages/e2e/test/architecture/tier-invisibility.test.ts`).

This package was reshaped in 0.6.0: the legacy orchestration-root and
wire-contracts packages were first merged into `@emploke/api`, then
the wire contracts were extracted back out into a separate
`@emploke/contracts` package to give the surfaces structural
isolation from orchestration code. See
[`docs/architecture.md § Tier model`](../../docs/architecture.md#tier-model)
for the rationale.

## Internal layout

```
packages/api/src/
├── application.ts            ← Application interface + composeApplication
├── workspace-context.ts      ← WorkspaceContext + WorkspaceContextRegistry
├── wiring/                   ← per-kind handler wiring (cross-BC glue)
│   └── schedule-task-handler.ts
└── index.ts                  ← public barrel (orchestration + re-exports
                                of @emploke/contracts)
```

Wire contracts (routes, response shapes, path helpers, etc.) live in
`packages/contracts/src/` — see `@emploke/contracts/README.md` for
that package's internal layout.

## Public API

```ts
import { composeApplication } from "@emploke/api";

const app = await composeApplication({
  workspace: { dbFile: "/abs/global.db" },
  runtimeRegistry,                              // RuntimeRegistry
  defaultWorkspaceParent: "/abs/home/workspaces",
  spawnFn,                                      // optional test seam; defaults to spawnTerminal
  logger,                                       // optional pino
});

// Orchestration (Stripe-style hybrid params)
await app.registerWorkspace({ name, workspaceDir? });
await app.renameWorkspace(id, { newName });
await app.unregisterWorkspace(id, { purge? });
await app.reloadWorkspace(id);

// Per-workspace contexts
const ctx = await app.getContext(id);            // WorkspaceContext | null
ctx.workspace;                                   // Workspace
ctx.catalog;                                     // CatalogService
ctx.sessions;                                    // SessionService
ctx.tasks;                                       // TaskService
await ctx.spawnSession(sid, { remote? });        // SpawnSessionResult

app.loadedContexts();                            // snapshot of currently-loaded contexts

await app.close();                               // closes every per-workspace context, then the global registry
```

## WorkspaceContext fields

Field naming follows the Stripe convention — singular for a
single-entity registry, plural for a collection / surface that exposes
list-like operations:

| Field      | Type             | Why singular / plural                                    |
| ---------- | ---------------- | -------------------------------------------------------- |
| `workspace`| `Workspace`      | one workspace                                            |
| `catalog`  | `CatalogService` | one catalog (the registry)                               |
| `sessions` | `SessionService` | many sessions per workspace; service is the collection   |
| `tasks`    | `TaskService`    | many tasks per workspace                                 |

`spawnSession` builds the session's interactive launch command via
`SessionService.buildInteractiveLaunch` and immediately hands it to
the configured terminal spawner (`@emploke/terminal`'s
`spawnTerminal` by default). The returned `display` field is always
populated so callers can show a copy-paste command even on spawn
failure.

## Concurrency invariants

Per-workspace context resolution is concurrency-safe: a second
`getContext(id)` racing the first load awaits the same in-flight
promise. `reloadWorkspace(id)` first awaits any in-flight load, then
closes and rebuilds — refused with `WorkspaceHasLiveTasksError` if
the cached context's `tasks.liveCount() > 0`. `Application.close()`
drains in-flight loads and closes every loaded context before
disposing the global registry, so callers don't have to remember the
ordering.

The internal `WorkspaceContextRegistry` class is the source-of-truth
holder of live SQLite handles, task supervisors, and SSE event buses.
It is **not** an optimisation cache that can be silently dropped —
dropping entries without `close()` leaks live resources. The class is
intentionally not exported from `@emploke/api`; all access goes
through `Application` methods.

## Tier

`@emploke/api` is the **T2 Application layer (orchestration)** in
emploke's tier model
(see [`docs/architecture.md § Tier model`](../../docs/architecture.md#tier-model)).
Its sibling at T2 is `@emploke/contracts` (wire types). T0
(foundations: `catalog`, `runtime`, `schedule`, `workspace`) and T1
(modes: `session`, `task`) sit below; T3 (`server`) and T_top
(`terminal`, `dashboard`, `cli`) sit above.

## Layering

`@emploke/api` MAY import (value or type):

- `@emploke/contracts` (re-exported from the public barrel).
- `@emploke/workspace`, `@emploke/catalog`, `@emploke/session`,
  `@emploke/task`, `@emploke/runtime`, `@emploke/schedule`,
  `@emploke/terminal` (the last for `spawnTerminal` during session
  spawn).

`@emploke/api` MUST NOT import:

- `@emploke/server` — server depends on api, not the reverse.
- `@emploke/dashboard`, `@emploke/cli` — surfaces depend on api
  (via `@emploke/contracts`), not the reverse.

## Testing

```sh
pnpm --filter @emploke/api test
```

Vitest runs in `forks` pool.

## License

MIT

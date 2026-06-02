# @emploke/api

The **T2 Application layer** — emploke's single composition root and
public type surface. Both the cross-package *contracts* (HTTP wire
shapes, out-of-band IPC files, `EMPLOKE_HOME` resolution) and the
*orchestration* that wires T0 / T1 packages (`workspace`, `catalog`,
`session`, `task`, `runtime`, `schedule`) into per-workspace runtime
contexts live here. Pairs with `@emploke/server` (HTTP transport) and
the surfaces (`@emploke/terminal`, `@emploke/dashboard`,
`@emploke/cli`).

This package was formed in 0.6.0 by merging emploke's legacy
orchestration-root and HTTP wire-contract packages into a single T2
package. See [`docs/architecture.md § Tier model`](../../docs/architecture.md#tier-model)
for the rationale.

## Internal layout

```
packages/api/src/
├── contracts/                ← types that cross the public boundary
│   ├── emploke-home.ts       (EMPLOKE_HOME + runtime.json + logs/ paths)
│   ├── health.ts             (GET /api/health response)
│   ├── plan-to-manifest.ts   (catalog install/sync ResolveManifest)
│   ├── routes.ts             (ROUTES table + RouteSpec primitives)
│   ├── runtimes.ts           (GET /api/runtimes wire shape)
│   ├── schedules.ts          (per-kind wire shapes for /schedules)
│   └── server-config.ts      (GET /api/config wire shape)
├── application.ts            ← Application interface + composeApplication
├── workspace-context.ts      ← WorkspaceContext + WorkspaceContextRegistry
├── wiring/                   ← per-kind handler wiring (cross-BC glue)
│   └── schedule-task-handler.ts
└── index.ts                  ← public barrel (union of both subsystems)
```

The `contracts/` vs root-of-`src/` split is purely for code
organisation. External consumers see one barrel
(`import { ... } from "@emploke/api"`); the split is not exposed via
separate subpath exports.

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

`@emploke/api` is the **T2 Application layer** in emploke's tier model
(see [`docs/architecture.md § Tier model`](../../docs/architecture.md#tier-model)).
T0 (foundations: `catalog`, `runtime`, `schedule`, `workspace`) and
T1 (modes: `session`, `task`) sit below; T3 (`server`) and T_top
(`terminal`, `dashboard`, `cli`) sit above.

## Layering

`@emploke/api` MAY import (value or type):

- `@emploke/workspace`, `@emploke/catalog`, `@emploke/session`,
  `@emploke/task`, `@emploke/runtime`, `@emploke/schedule`,
  `@emploke/terminal` (the last for `spawnTerminal` during session
  spawn).

`@emploke/api` MUST NOT import:

- `@emploke/server` — server depends on api, not the reverse.
- `@emploke/dashboard`, `@emploke/cli` — surfaces depend on api, not
  the reverse.

**`src/contracts/` internal sub-rule:** prefer `import type` over
value imports; the contracts directory is a tree-shake-friendly leaf
so dashboard / cli can pull wire types without dragging in
orchestration code paths.

## Testing

```sh
pnpm --filter @emploke/api test
```

Vitest runs in `forks` pool.

## License

MIT

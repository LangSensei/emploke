# @emploke/core

Composition root that wires the workspace registry to per-workspace
contexts. Server (and future CLI / MCP / SDK consumers) call
`composeApplication({...})` once and route every per-workspace
request through the returned `Application`.

Beyond per-workspace context resolution, this surface exposes the
canonical cross-BC orchestration methods (`registerWorkspace`,
`renameWorkspace`, `unregisterWorkspace`, `reloadWorkspace`) so
transport layers (HTTP routes, CLI commands) become thin adapters.

## Public API

```ts
import { composeApplication } from "@emploke/core";

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
intentionally not exported from `@emploke/core`; all access goes
through `Application` methods.

## Layering

Core may import:
- `@emploke/workspace`
- `@emploke/catalog`
- `@emploke/session`
- `@emploke/task`
- `@emploke/runtime`
- `@emploke/terminal`

Core must NOT import:
- `@emploke/server` — server depends on core, not the reverse
- `@emploke/dashboard`
- `@emploke/cli`

## Testing

```sh
pnpm --filter @emploke/core test
```

Vitest runs in `forks` pool.

## License

MIT

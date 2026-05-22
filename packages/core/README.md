# @emploke/core

Composition root that wires the workspace registry to per-workspace
runtimes. Server (and future CLI / MCP / SDK consumers) call
`composeEmplokeCore({...})` once and route every per-workspace
request through the returned cache.

Beyond the cache, this surface exposes the canonical cross-BC
orchestration methods (`registerWorkspace`, `renameWorkspace`,
`unregisterWorkspace`, `reloadWorkspace`) so transport layers (HTTP
routes, CLI commands) become thin adapters.

## Public API

```ts
import { composeEmplokeCore } from "@emploke/core";

const core = await composeEmplokeCore({
  workspace: { dbFile: "/abs/global.db" },
  runtimeRegistry,                              // RuntimeRegistry
  defaultWorkspaceParent: "/abs/home/workspaces",
  spawnFn,                                      // optional test seam; defaults to spawnTerminal
  logger,                                       // optional pino
});

// Orchestration (Stripe-style hybrid params)
await core.registerWorkspace({ name, workspaceDir? });
await core.renameWorkspace(id, { newName });
await core.unregisterWorkspace(id, { purge? });
await core.reloadWorkspace(id);

// Per-workspace runtimes
const rt = await core.runtimes.get(id);         // WorkspaceRuntime | null
rt.workspace;                                    // Workspace
rt.catalog;                                      // CatalogService
rt.sessions;                                     // SessionService
rt.tasks;                                        // TaskService
await rt.spawnSession(sid, { remote? });         // SpawnSessionResult

await core.close();                              // cache.closeAll + workspaceModule.close
```

## WorkspaceRuntime fields

Field naming follows the Stripe convention  singular for a
single-entity registry, plural for a collection / surface that exposes
list-like operations:

| Field      | Type             | Why singular / plural                                    |
| ---------- | ---------------- | -------------------------------------------------------- |
| `workspace`| `Workspace`      | one workspace                                            |
| `catalog`  | `CatalogService` | one catalog (the registry)                               |
| `sessions` | `SessionService` | many sessions per workspace; service is the collection   |
| `tasks`    | `TaskService`    | many tasks per workspace                                 |

`spawnSession` builds the session''s interactive launch command via
`SessionService.buildInteractiveLaunch` and immediately hands it to
the configured terminal spawner (`@emploke/terminal`''s
`spawnTerminal` by default). The returned `display` field is always
populated so callers can show a copy-paste command even on spawn
failure.

## WorkspaceRuntimeCache

```ts
const cache = core.runtimes;

await cache.get(id);          // lazy-load + memoise
await cache.invalidate(id);   // close + drop entry (called after rename/unregister)
await cache.reload(id);       // refused with WorkspaceHasLiveTasksError if liveCount > 0
cache.loaded();               // snapshot of currently-cached runtimes
await cache.closeAll();       // closes every entry; idempotent
```

The cache is concurrency-safe: a second `get(id)` racing the first
load awaits the same in-flight promise. `reload(id)` first awaits
any in-flight load, then closes and rebuilds. `EmplokeCore.close`
calls `cache.closeAll()` internally before closing the global
registry so callers don''t have to remember the ordering.

## Layering

Core may import:
- `@emploke/workspace`
- `@emploke/catalog`
- `@emploke/session`
- `@emploke/task`
- `@emploke/runtime`
- `@emploke/terminal`

Core must NOT import:
- `@emploke/server`  server depends on core, not the reverse
- `@emploke/dashboard`
- `@emploke/cli`

## Testing

```sh
pnpm --filter @emploke/core test
```

Vitest runs in `forks` pool.

## License

MIT
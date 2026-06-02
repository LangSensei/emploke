# @emploke/workspace

A *workspace* is a user-chosen directory that holds emploke's
per-project state. This package manages only the registry side: a
single `$EMPLOKE_HOME/global.db` SQLite table mapping opaque UUIDs to
absolute paths, plus allocation/cleanup of the per-workspace
`sessions/` and `tasks/` subdirectories. The per-workspace
`workspace.db` file is created and populated by sibling packages
(`@emploke/session`, `@emploke/task`, `@emploke/catalog`). The
directory is normally user-chosen but can also be auto-allocated under
`$EMPLOKE_HOME/workspaces/<uuid>/` when the caller doesn't specify
one. The global registry stores each workspace's display name +
last-opened timestamp; there is no per-workspace metadata sidecar
file.

## Layout

```
packages/workspace/src/
  schema.ts                  Drizzle table def (private; only types exported)
  errors.ts                  Domain error classes (exported)
  types.ts                   Public DTOs (Workspace) (exported)
  validate.ts                Input schemas + assertValid* helpers
  workspace-repository.ts    Drizzle CRUD (private; never exported)
  workspace-entity.ts        WorkspaceEntity (private; service projects to DTO)
  workspace-service.ts       WorkspaceService — register/open/rename/unregister + reads
  layout.ts                  Pure path helpers (workspaceLayout, globalDbPath, ...)
  migrations.ts              applyWorkspaceMigrations (drizzle migration applier)
  compose.ts                 composeWorkspaceModule({ dbFile, logger? })
  index.ts                   public barrel
drizzle/                     generated SQL migrations (committed)
drizzle.config.ts            drizzle-kit config
```

## Public API

```ts
import { composeWorkspaceModule, WorkspaceService } from "@emploke/workspace";

const { service, close } = await composeWorkspaceModule({
  dbFile: "/abs/path/to/global.db",
});

// Reads
await service.list();                           // Workspace[]
await service.getById(id);                      // Workspace | null
await service.getLastOpened();                  // Workspace | null
await service.getLastOpenedId();                // string | null

// Writes (Stripe-style hybrid: primary key positional, options in bag)
await service.register({ id, workspaceDir, name });
await service.open(id);
await service.rename(id, { newName });
await service.unregister(id, { purge: false });

await close();                                  // closes the SQLite handle
```

The service owns reads + writes. There is no separate `Queries`
class. The repository is package-private — consumers go through the
service.

## On-disk wire format

```sql
-- $EMPLOKE_HOME/global.db
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  workspace_dir   TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_opened_at  TEXT NULL
);
```

The workspace with the greatest `last_opened_at` is what
`getLastOpened` returns; it's the registry's "current" workspace from
the user's POV. `register` sets `last_opened_at = now` (registration
is implicit first-open); `open(id)` updates it on subsequent opens.
`ORDER BY last_opened_at DESC` pushes never-opened rows last
(SQLite's default NULL-sort under DESC).

Per-workspace metadata (`name`, `createdAt`) lives in the same
`workspaces` row — there is no `<workspace>/workspace.json` sidecar.

## Errors

```
WorkspaceError
├── WorkspaceNameInvalidError      400 — name failed validation
├── WorkspaceIdInvalidError        400 — id is not a valid UUID
├── WorkspaceNotRegisteredError    404 — id has no entry in the registry
├── WorkspaceIdConflictError       409 — register({id}) collision
├── WorkspacePathConflictError     409 — workspaceDir already registered
└── RegistryError                  500 — registry-level failure (base)
```

`list()` returns workspaces ordered by `lastOpenedAt DESC`. `getById(id)`
returns `null` for unknown ids AND malformed ids alike — reads do not
validate the id. Only write methods (`register`, `open`, `rename`,
`unregister`) validate and throw `WorkspaceIdInvalidError`.

Concurrency: `register`'s pre-flight conflict checks are best-effort
UX. Two concurrent registers can race past them; the UNIQUE / PRIMARY
KEY constraints on the `workspaces` table are the deterministic
backstop, and the insert is wrapped to translate SQLite constraint
errors back into typed domain errors.

## Layout helper

```ts
import { workspaceLayout, globalDbPath, workspacesParentDir } from "@emploke/workspace";

workspaceLayout("/abs/workspace-dir");
// {
//   sessions: "/abs/workspace-dir/sessions",
//   tasks:    "/abs/workspace-dir/tasks",
//   workflow: "/abs/workspace-dir/workflows",
// }

globalDbPath("/abs/home");        // "/abs/home/global.db"
workspacesParentDir("/abs/home"); // "/abs/home/workspaces"
```

All pure functions; no fs side effects. Used by downstream services
(`SessionService` / `TaskService` / `CatalogService`) to compute the
directories agents and runtimes use.

The `workflow` slot is currently unused inside this package:
`register` does not allocate it and `unregister({ purge: true })`
does not remove it. The `workflows/` directory is owned and resolved
independently by `@emploke/workflow` via its own `workflowRoot()`
helper; the slot here is retained only because the `WorkspaceLayout`
type is in the public barrel and narrowing it would be a breaking
change. Do not add new in-pkg consumers; route to `@emploke/workflow`
instead.

## Testing

```sh
pnpm --filter @emploke/workspace test
```

Tests run against `dbFile: ":memory:"` opened via the same
`composeWorkspaceModule` so the schema goes through the real
migrator. Vitest runs in `forks` pool (better-sqlite3's native
binding segfaults on worker-thread teardown on Windows).

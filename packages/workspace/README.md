# @emploke/workspace

Per-project root abstraction. A *workspace* is a directory that holds
emploke's per-project state (sessions, tasks, catalog) inside a single
`workspace.db` SQLite file. The directory is normally
user-chosen but can also be auto-allocated under
`$EMPLOKE_HOME/workspaces/<uuid>/` when the caller doesn't specify one
(see `Quick start` below). The `$EMPLOKE_HOME/global.db` SQLite registry
maps opaque UUIDs to absolute workspace paths and stores each
workspace's display name + defaults — there is no per-workspace
metadata sidecar file.

## Concepts

- **`Workspace`** — DDD entity (class, not interface). Constructed
  via `Workspace.create({...})` for fresh entities and
  `Workspace.fromStored({...})` when rehydrating from storage.
  Carries `{ id, name, createdAt, workdir, defaults? }`. `workdir` is
  the only filesystem field; everything else is pure metadata. Use
  `withMetadata({...})` to derive a new instance preserving identity
  (id / workdir / createdAt are immutable across edits).
- **The `id`** is an opaque UUID, the URL routing key in the HTTP API.
  Stable for the lifetime of the registry entry — dashboard URLs
  survive workspace renames.
- **The `name`** is free-form display text, edited via the sidebar's
  pencil icon. Has no routing significance.
- **Standard subdirs** — `sessions/`, `tasks/`, `catalog/`, plus the
  shared per-workspace `workspace.db`. Created at `init`; computed
  from `workdir` by the `workspaceLayout` helper. Not stored on the
  type so the repository contract has no on-disk path coupling.

## Quick start

```ts
import { DatabaseSync } from "node:sqlite";
import { WorkspaceManager, SqliteWorkspaceRepository } from "@emploke/workspace";

const db = new DatabaseSync("/Users/me/.emploke/global.db");
const repo = new SqliteWorkspaceRepository({ db });
const workspaces = new WorkspaceManager(repo);

const ws = await workspaces.init({
  name: "Acme prod",
  workdir: "/Users/me/code/acme",
});
// → creates /Users/me/code/acme/{workspace.db,sessions,tasks,catalog}
// → inserts {id, workdir, name, createdAt, defaults} into global.db.workspaces

// `workdir` is always required at the manager layer — defaulting it
// to `$EMPLOKE_HOME/workspaces/<uuid>/` is the responsibility of the
// HTTP route (`POST /api/workspaces`), which owns the policy decision
// of where to put auto-allocated workspaces. The manager stays a
// pure persistence boundary.

const all = await workspaces.list();
const back = await workspaces.read(ws.id);
await workspaces.update(ws.id, { name: "Acme prod (renamed)" });
await workspaces.delete(ws.id);                 // metadata-only
await workspaces.delete(ws.id, { purge: true }); // also rm sessions/, tasks/, catalog/, ...
```

The `workdir` itself is **never** removed by `delete({ purge: true })`
— it's user-owned. Only emploke-owned subdirs are wiped.

## Manager API

```ts
class WorkspaceManager {
  constructor(repo: WorkspaceRepository);

  list(): Promise<Workspace[]>;
  read(id: string): Promise<Workspace | null>;
  init(opts: WorkspaceInitOpts): Promise<Workspace>;       // throws on id/path conflict
  update(id, patch: WorkspaceUpdatePatch): Promise<Workspace>;
  delete(id, opts?: { purge?: boolean }): Promise<void>;   // idempotent
  getCurrent(): Promise<string | null>;
  setCurrent(id: string): Promise<void>;                   // most-recently-selected
}
```

`init` mints a fresh UUID by default; pass `id` explicitly only in
tests / migrations. The id-uniqueness check happens **inside the
registry lock** via `repository.create()`, so two concurrent
`init({id: same})` calls produce one success + one
`WorkspaceIdConflictError` rather than silently overwriting each
other.

## Repository

```ts
interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  read(id: string): Promise<Workspace | null>;
  save(workspace: Workspace): Promise<void>;     // upsert
  create(workspace: Workspace): Promise<void>;   // atomic create-or-fail
  delete(id: string): Promise<void>;
  getCurrent(): Promise<string | null>;
  setCurrent(id: string): Promise<void>;
}
```

Production runs `SqliteWorkspaceRepository` against
`$EMPLOKE_HOME/global.db`. Tests use the same class against a
`":memory:"` `DatabaseSync` (re-exported via `@emploke/workspace/testing`)
— there is no separate in-memory implementation, matching the pattern
the other SQLite-backed entity packages (`@emploke/task`,
`@emploke/session`, `@emploke/catalog`) use.

> Why SQLite for the registry?
> See [docs/architecture.md → Backend selection](../../docs/architecture.md#backend-selection-when-fs-when-sqlite)
> for the project-wide decision rule. The registry has multi-write
> concurrency requirements (concurrent `workspace add` calls) that
> SQLite's atomic INSERT + UNIQUE constraints solve more cleanly than
> the previous JSON-file + advisory-lock dance.

## On-disk wire format

```sql
-- $EMPLOKE_HOME/global.db
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  workdir         TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  registered_at   TEXT NOT NULL,
  last_opened_at  TEXT,
  defaults_json   TEXT
);
CREATE TABLE global_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- e.g. ('current_workspace_id', '<uuid>')

CREATE TABLE schema_meta (
  pkg     TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0)
);
-- workspace pkg owns one row: ('workspace', 1)
```

Per-workspace metadata (`name`, `createdAt`, `defaults`) lives in the
same `workspaces` row as the registry id/workdir/timing — there is
no `<workspace>/workspace.json` sidecar. Schema version is tracked
in the multi-row `schema_meta` table so each entity package can
bump its own version independently.

## Errors

```ts
WorkspaceError
├── WorkspaceNameInvalidError      400 — name failed validation
├── WorkspaceIdInvalidError        400 — id is not a valid UUID
├── WorkspaceNotRegisteredError    404 — id has no entry in the index
├── WorkspaceNotFoundError         404 — workdir gone
├── WorkspaceIdConflictError       409 — init({id}) collision
├── WorkspacePathConflictError     409 — workdir already registered
├── WorkspaceCorruptedError        500 — workspaces row is unreadable
└── RegistryError / RegistryCorruptedError / RegistrySchemaMismatchError
```

`list()` is resilient to per-entry corruption: if one workspace's
metadata is unreadable it's silently dropped from the result rather
than failing the whole list. `read(id)` still throws the typed error.

## Layout helper

```ts
import { workspaceLayout } from "@emploke/workspace";

const layout = workspaceLayout("/abs/workdir");
// {
//   sessions:  "/abs/workdir/sessions",
//   tasks:     "/abs/workdir/tasks",
//   catalog:   "/abs/workdir/catalog",
// }
```

Pure function; no fs side effects. Used by downstream managers
(SessionManager / TaskManager / CatalogManager) to compute the
directories agents and runtimes use.

## Testing

```sh
pnpm --filter @emploke/workspace test
```

34 tests cover init / list / read / update / delete (with + without
purge), concurrency (init id-conflict races), and repository
corruption (per-entry list isolation).

## License

MIT

# @emploke/workspace

Per-project root abstraction. A *workspace* is a user-chosen directory
that holds emploke's per-project state (sessions, tasks, catalog,
workflows, logs) plus a self-describing `workspace.json`. The
`$EMPLOKE_HOME/workspaces.json` registry maps opaque UUIDs to absolute
workspace paths.

## Concepts

- **`Workspace`** — flat domain value: `{ id, name, createdAt, workdir,
  defaults? }`. The `workdir` is the only filesystem field; everything
  else is pure metadata that survives a backend swap (FS today, SQLite
  tomorrow).
- **The `id`** is an opaque UUID, the URL routing key in the HTTP API.
  Stable for the lifetime of the registry entry — dashboard URLs
  survive workspace renames.
- **The `name`** is free-form display text, edited via the sidebar's
  pencil icon. Has no routing significance.
- **Standard subdirs** — `sessions/`, `tasks/`, `catalog/`,
  `workflows/`, `logs/`. Created at `init`; computed from `workdir`
  by the `workspaceLayout` helper. Not stored on the type so a
  SQLite-backed repository wouldn't have to round-trip the layout.

## Quick start

```ts
import { WorkspaceManager, FsWorkspaceRepository } from "@emploke/workspace";

const repo = new FsWorkspaceRepository({
  indexFile: "/Users/me/.emploke/workspaces.json",
});
const workspaces = new WorkspaceManager(repo);

const ws = await workspaces.init({
  name: "Acme prod",
  workdir: "/Users/me/code/acme",
});
// → creates /Users/me/code/acme/{workspace.json,sessions,tasks,catalog,workflows,logs}
// → adds {id, workdir} to the index

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

Two implementations ship:

- **`FsWorkspaceRepository`** — production. Single `workspaces.json`
  index protected by an advisory lock (`workspaces.json.lock` via
  `@emploke/storage`'s `withFileLock`); per-workspace metadata at
  `<workdir>/workspace.json` written atomically inside the same lock.
- **`InMemoryWorkspaceRepository`** at `@emploke/workspace/testing` —
  for fast unit tests. Mirrors the FS impl's id validation + path
  conflict semantics so tests can't pass on inputs that production
  would reject.

## On-disk wire format

```jsonc
// $EMPLOKE_HOME/workspaces.json
{
  "schemaVersion": 1,
  "entries": [
    { "id": "uuid-1", "workdir": "/abs/path", "lastOpenedAt": "..." }
  ],
  "currentId": "uuid-1"
}

// <workspace>/workspace.json
{
  "schemaVersion": 1,
  "name": "Acme prod",
  "createdAt": "2026-05-09T12:00:00.000Z",
  "defaults": { "runtime": "copilot", "agent": "code-reviewer" }
}
```

`schemaVersion` is FS-repository internal — never appears on the
domain `Workspace` type.

## Errors

```ts
WorkspaceError
├── WorkspaceNameInvalidError      400 — name failed validation
├── WorkspaceIdInvalidError        400 — id is not a valid UUID
├── WorkspaceNotRegisteredError    404 — id has no entry in the index
├── WorkspaceNotFoundError         404 — workdir gone
├── WorkspaceIdConflictError       409 — init({id}) collision
├── WorkspacePathConflictError     409 — workdir already registered
├── WorkspaceCorruptedError        500 — workspace.json unreadable
├── WorkspaceSchemaMismatchError   500 — schemaVersion not supported
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
//   workflows: "/abs/workdir/workflows",
//   logs:      "/abs/workdir/logs",
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

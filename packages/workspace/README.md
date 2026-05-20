# @emploke/workspace

Per-project root abstraction. A *workspace* is a directory that holds
emploke's per-project state (sessions, tasks, catalog) inside a single
`workspace.db` SQLite file plus agent workdirs under `sessions/` and
`tasks/`. The directory is normally user-chosen but can also be
auto-allocated under `$EMPLOKE_HOME/workspaces/<uuid>/` when the caller
doesn't specify one. The `$EMPLOKE_HOME/global.db` SQLite registry
maps opaque UUIDs to absolute workspace paths and stores each
workspace's display name — there is no per-workspace metadata sidecar
file.

> **Phase 1 of #135 (architecture-v2):** this package is the **canonical
> reference** for the project-wide DDD + CQRS conventions locked in
> `.ceo/design/naming-conventions.md` (issue #137). Every subsequent
> phase (runtime, session, task, catalog, workflow) copies the layout
> below; deviating from it is a discussion to have in #137, not in this
> README.

## Layout

```
packages/workspace/src/
├── domain/                    ← pure, zero infrastructure deps
│   ├── workspace.ts                   ← Aggregate root (private ctor, factories, events)
│   ├── workspace-repository.ts        ← abstract class (DI token)
│   ├── errors.ts                      ← Typed domain exceptions
│   ├── publish-event.ts               ← internal mediator.publish wrapper
│   ├── value-objects/
│   │   ├── workspace-id.ts            ← WorkspaceId.of(uuid).equals(...) + isValid/assertValid statics
│   │   ├── workspace-name.ts          ← WorkspaceName + isValid/assertValid statics
│   │   └── workspace-dir.ts           ← WorkspaceDir resolve-on-build
│   └── events/
│       ├── domain-event.ts            ← base WorkspaceDomainEvent
│       ├── workspace-registered.ts
│       ├── workspace-renamed.ts
│       └── workspace-unregistered.ts
│
├── application/               ← use cases + orchestration
│   ├── module.ts                      ← composeWorkspaceModule(container)
│   ├── commands/
│   │   ├── register-workspace/
│   │   ├── rename-workspace/
│   │   ├── unregister-workspace/
│   │   └── set-current-workspace/
│   └── queries/
│       ├── workspace-queries.ts       ← abstract class (DI token)
│       └── views/
│           ├── workspace-view.ts      ← interface (no DI)
│           └── workspace-summary-view.ts
│
├── infrastructure/            ← adapters
│   ├── workspace-db.ts                ← const WorkspaceDb (Symbol-keyed DI token)
│   ├── sqlite-workspace-repository.ts ← @injectable extends WorkspaceRepository
│   ├── sqlite-workspace-queries.ts    ← @injectable extends WorkspaceQueries
│   ├── internal/
│   │   └── row-mappers.ts             ← rowToWorkspace (pkg-private)
│   └── migrations/
│       ├── index.ts                   ← WORKSPACE_MIGRATIONS chain
│       ├── v0-to-v1.ts                ← initial schema
│       └── v1-to-v2.ts                ← drop defaults_json, rename workdir → workspace_dir
│
├── workspace-layout.ts        ← pure helper (used by downstream pkgs)
├── migration/                 ← shared migration framework (used by every pkg)
├── index.ts                   ← public API barrel
└── testing.ts                 ← test-only re-exports
```

## Public API

The barrel (`@emploke/workspace`) exports:

- **Commands** (dispatch via `mediator.send(...)`):
  - `RegisterWorkspaceCommand(id, workspaceDir, name) → { id }`
  - `RenameWorkspaceCommand(id, newName) → void`
  - `UnregisterWorkspaceCommand(id, purge=false) → void`
  - `SetCurrentWorkspaceCommand(id) → void` *(see polish-backlog P1-5)*
- **Queries** (inject via `@inject(WorkspaceQueries)`):
  - `WorkspaceQueries.getById(id) → WorkspaceView | null`
  - `WorkspaceQueries.list() → WorkspaceSummaryView[]`
  - `WorkspaceQueries.getCurrent() → WorkspaceView | null`
  - `WorkspaceQueries.getCurrentId() → string | null`
- **Composition**: `composeWorkspaceModule(container)`
- **DI tokens**: `WorkspaceDb` (Symbol; bound to `<EMPLOKE_HOME>/global.db`)
- **Cross-context value objects**: `WorkspaceId`
- **Typed errors**: `WorkspaceNotRegisteredError`, `WorkspaceIdConflictError`,
  `WorkspacePathConflictError`, `WorkspaceNameInvalidError`, etc.
- **Migration framework**: `runPkgMigrations`, `WORKSPACE_MIGRATIONS`,
  `MigrationCoordinator`, related errors

The `Workspace` aggregate, `WorkspaceRepository` interface, concrete
repository / handlers, and value objects beyond `WorkspaceId` are
**package-private**. Tests that need the SQLite implementation directly
import from `@emploke/workspace/testing`.

## Wiring

The composition root (`@emploke/server`, `@emploke/cli`) is responsible
for two bindings before calling `composeWorkspaceModule`:

```ts
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { composeWorkspaceModule, WorkspaceDb } from "@emploke/workspace";

const container = new Container();
const resolver = new InversifyResolver(container);
const mediator = new Mediator({ resolver });
container.bind(Mediator).toConstantValue(mediator);
container.bind(WorkspaceDb).toConstantValue(globalDb);

composeWorkspaceModule(container);
```

Then:

```ts
import { RegisterWorkspaceCommand, WorkspaceQueries } from "@emploke/workspace";

const result = await mediator.send(
  new RegisterWorkspaceCommand(id, "/abs/path", "Acme prod"),
);
// result.id === id

const queries = container.get(WorkspaceQueries);
const view = await queries.getById(result.id);
```

## Aggregate semantics

`Workspace` is an aggregate root with a **private constructor** plus
two factories:

- `Workspace.register({ id, name, workspaceDir, now })` — fresh
  workspace, raises a `WorkspaceRegistered` event.
- `Workspace.fromStored({ id, name, workspaceDir, createdAt })` —
  rehydrate from storage. Validation failures throw
  `WorkspaceCorruptedError` carrying the on-disk path.

State transitions are methods on the aggregate that raise events
internally; the command handler drains them with `pullDomainEvents()`
after `repo.save(...)` and publishes via `mediator.publish(...)`. Phase
1 has **zero notification handlers** (workspace is the root context);
the publish path is exercised end-to-end so subsequent phases can
add subscribers without re-litigating the wiring.

```ts
ws.rename(WorkspaceName.of("New name"), clock.nowIso());
ws.unregister(clock.nowIso(), { purged: true });
const events = ws.pullDomainEvents();  // drains; second call returns []
```

## On-disk wire format

```sql
-- $EMPLOKE_HOME/global.db
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  workspace_dir   TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  registered_at   TEXT NOT NULL,
  last_opened_at  TEXT
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
-- workspace pkg owns one row: ('workspace', 2)
```

Per-workspace metadata (`name`, `createdAt`) lives in the same
`workspaces` row as the registry id/workspaceDir/timing — there is
no `<workspace>/workspace.json` sidecar.

## Errors

```
WorkspaceError
├── WorkspaceNameInvalidError      400 — name failed validation
├── WorkspaceIdInvalidError        400 — id is not a valid UUID
├── WorkspaceNotRegisteredError    404 — id has no entry in the index
├── WorkspaceNotFoundError         404 — workspaceDir gone
├── WorkspaceIdConflictError       409 — register({id}) collision
├── WorkspacePathConflictError     409 — workspaceDir already registered
├── WorkspaceCorruptedError        500 — workspaces row is unreadable
└── RegistryError / RegistryCorruptedError / RegistrySchemaMismatchError
```

`WorkspaceQueries.list()` is resilient to per-row corruption: a single
unreadable workspace is silently dropped rather than failing the whole
list. `getById(id)` still throws the typed error.

## Layout helper

```ts
import { workspaceLayout } from "@emploke/workspace";

const layout = workspaceLayout("/abs/workspace-dir");
// { sessions: "/abs/workspace-dir/sessions", tasks: "/abs/workspace-dir/tasks" }
```

Pure function; no fs side effects. Used by downstream managers
(`SessionManager` / `TaskManager` / `CatalogManager`) to compute the
directories agents and runtimes use.

## Testing

```sh
pnpm --filter @emploke/workspace test
```

106 tests cover:

- **domain/** — value objects, aggregate (register / rename / unregister),
  domain events
- **application/** — command handler tests with mock `WorkspaceRepository`
  + mock `Mediator`, plus an end-to-end module-composition test
- **infrastructure/** — `SqliteWorkspaceRepository` and
  `SqliteWorkspaceQueries` integration against `:memory:` SQLite
- **migration/** — coordinator integration (cross-pkg topo sort,
  rollback on failure, v1-to-v2 migration verification)

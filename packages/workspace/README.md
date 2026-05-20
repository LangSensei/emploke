# @emploke/workspace

Per-project root abstraction. A *workspace* is a directory holding
emploke's per-project state (sessions, tasks, catalog) inside a single
`workspace.db` SQLite file plus agent workdirs under `sessions/` and
`tasks/`. The directory is normally user-chosen but can also be
auto-allocated under `$EMPLOKE_HOME/workspaces/<uuid>/` when the caller
doesn't specify one. The `$EMPLOKE_HOME/global.db` SQLite registry
maps opaque UUIDs to absolute workspace paths and stores each
workspace's display name + last-opened timestamp  there is no
per-workspace metadata sidecar file.

> **Phase 2 of #135 (architecture-v2):** this package is the canonical
> reference for the project-wide DDD + CQRS conventions locked in
> `.ceo/design/naming-conventions.md` (issue #137). Persistence runs
> on **MikroORM** with a per-context `EntityManager`. Subsequent
> phases (runtime, session, task, catalog, workflow) copy the layout
> below; deviating from it is a discussion to have in #137, not in
> this README.

## Layout

```
packages/workspace/src/
 domain/                                     pure, zero infrastructure deps
    seedwork/
       entity.ts                           id + identity equality + domain-events buffer
       aggregate-root.ts                   marker interface (mirrors eShop IAggregateRoot)
       value-object.ts                     structural equality base
    exceptions/
       workspace-errors.ts                 typed domain exceptions
    workspace-layout.ts                     pure helper (used by downstream pkgs)
    aggregates/
        workspace/
            workspace.ts                    aggregate root (@Entity, factories, transitions)
            workspace-repository.ts         abstract class (DI token)
            workspace-id.ts                 VO: UUID with isValid/assertValid
            workspace-name.ts               VO: display name
            workspace-dir.ts                VO: absolute path resolve-on-build

 application/                                use cases + orchestration
    workspace.di.ts                         composeWorkspaceModule(container, options)
    behaviors/
       logging-behavior.ts                 outermost mediator pipeline behavior
       validation-behavior.ts              multi-injects CommandValidators
       transaction-behavior.ts             em.transactional wrapper (innermost)
    commands/
       register-workspace.command.ts
      ─ register-workspace.command-handler.ts
       rename-workspace.command.ts
       rename-workspace.command-handler.ts
       unregister-workspace.command.ts
       unregister-workspace.command-handler.ts
       open-workspace.command.ts
       open-workspace.command-handler.ts
    validations/
       command-validator.ts                abstract base (DI token; declares `command` ctor)
       register-workspace.command-validator.ts
       rename-workspace.command-validator.ts
       unregister-workspace.command-validator.ts
       open-workspace.command-validator.ts
    queries/
        workspace-queries.ts                abstract class (DI token)
        mikro-workspace-queries.ts          @injectable knex-driven implementation
        views/
            workspace-view.ts               interface (no DI)
            workspace-summary-view.ts

 infrastructure/                             adapters
    workspace-context.ts                    EntityManager wrapper (eShop OrderingContext analog)
    workspace-entities.ts                   WORKSPACE_ENTITIES = [Workspace]
    domain-event-dispatcher.ts              MikroORM beforeFlush subscriber  mediator.publish
    repositories/
       mikro-workspace-repository.ts       @injectable extends WorkspaceRepository
    migrations/
        Migration00000000000000_initial.ts  creates `workspaces` table

 legacy/                                     Phase-1 carry-over (slated for removal)
 index.ts                                    public API barrel
 testing.ts                                  test-only re-exports
```

## Public API

The barrel (`@emploke/workspace`) exports:

- **Commands** (dispatch via `mediator.send(...)`):
  - `RegisterWorkspaceCommand(id, workspaceDir, name)  { id }`
  - `RenameWorkspaceCommand(id, newName)  void`
  - `UnregisterWorkspaceCommand(id, purge=false)  void`
  - `OpenWorkspaceCommand(id)  void`
- **Queries** (inject via `@inject(WorkspaceQueries)`):
  - `WorkspaceQueries.getById(id)  WorkspaceView | null`
  - `WorkspaceQueries.list()  WorkspaceSummaryView[]` *(ordered by `lastOpenedAt` DESC, ties by `createdAt` DESC)*
  - `WorkspaceQueries.getLastOpened()  WorkspaceView | null`
  - `WorkspaceQueries.getLastOpenedId()  string | null`
- **Composition**: `composeWorkspaceModule(container, options)` 
  options are either `{ dbFile }` (workspace pkg owns the ORM) or
  `{ orm }` (caller owns it; tests use this form via
  `openTestWorkspaceOrm`).
- **Cross-context value objects**: `WorkspaceId`
- **Typed errors**: `WorkspaceNotRegisteredError`,
  `WorkspaceIdConflictError`, `WorkspacePathConflictError`,
  `WorkspaceNameInvalidError`, `WorkspaceIdInvalidError`,
  `WorkspaceCorruptedError`, etc.

The `Workspace` aggregate, `WorkspaceRepository`, concrete
repository / handlers, and value objects beyond `WorkspaceId` are
**package-private**. Tests that need the implementation directly
import from `@emploke/workspace/testing`.

## Wiring

The composition root (`@emploke/server`, `@emploke/cli`) is
responsible for binding `Mediator` before calling
`composeWorkspaceModule`:

```ts
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { composeWorkspaceModule } from "@emploke/workspace";

const container = new Container();
const resolver = new InversifyResolver(container);
const mediator = new Mediator({ resolver });
container.bind(Mediator).toConstantValue(mediator);

const handle = await composeWorkspaceModule(container, {
  dbFile: "/path/to/global.db",
});
// ... use the container ...
await handle.close();   // closes the workspace pkg's MikroORM instance
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

## Pipeline behaviors

`composeWorkspaceModule` registers three pipeline behaviors on the
shared mediator (outermost  innermost):

1. **LoggingBehavior**  wraps every dispatch (so failed validations
   still log).
2. **ValidationBehavior**  multi-injects `CommandValidator`
   instances and dispatches by `command` ctor identity. A failed
   validator throws BEFORE `TransactionBehavior` opens a transaction.
3. **TransactionBehavior**  wraps the handler in
   `em.transactional`. The auto-flush at scope exit triggers the
   `DomainEventDispatcher` MikroORM subscriber, then commits SQL.

Order is asserted by `workspace.di.test.ts`.

## Aggregate semantics

`Workspace` is a MikroORM `@Entity` and a domain aggregate root.
The class has a **protected constructor** plus two factories:

- `Workspace.register({ id, name, workspaceDir, now })`  fresh
  workspace. Sets `lastOpenedAt = now` (registration is implicit
  first-open).
- `Workspace.fromStored({ id, name, workspaceDir, createdAt, lastOpenedAt? })` 
  rehydrate from storage. Validation failures throw
  `WorkspaceCorruptedError` carrying the on-disk path.

Transitions:

```ts
ws.rename(WorkspaceName.of("New name"));   // no-op when name is unchanged
ws.open(clock.nowIso());                   // updates lastOpenedAt
```

`unregister` is not a method on the aggregate  the
`UnregisterWorkspaceCommandHandler` calls `repo.delete(id)` directly
after optionally purging on-disk subdirs (`sessions/`, `tasks/`).

### Domain events

The aggregate currently raises **no** domain events. The seedwork
machinery (Entity events buffer typed as mediatr-ts
`NotificationData[]` + `DomainEventDispatcher` MikroORM subscriber +
mediator publish) is fully wired and stays latent. To add the first
event:

1. Define the event class extending `NotificationData`.
2. Define a notification handler and register it with the mediator.
3. Call `this.addDomainEvent(...)` from the relevant transition.

`DomainEventDispatcher` does **NOT** swallow "no handler found"
errors  a forgotten handler fails the flush loudly, enforcing the
rule "no event class exists without a handler" at runtime.

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
-- The workspace with the greatest `last_opened_at` is what
-- `WorkspaceQueries.getLastOpened` returns; it's the registry's
-- "current" workspace from the user's POV. `register` sets
-- `last_opened_at = now` (registration is implicit first-open);
-- `OpenWorkspaceCommand` updates it on subsequent opens.
-- ORDER BY last_opened_at DESC pushes never-opened rows last
-- (SQLite's default NULL-sort under DESC).
```

Per-workspace metadata (`name`, `createdAt`) lives in the same
`workspaces` row  there is no `<workspace>/workspace.json` sidecar.

## Errors

```
WorkspaceError
 WorkspaceNameInvalidError      400  name failed validation
 WorkspaceIdInvalidError        400  id is not a valid UUID
 WorkspaceNotRegisteredError    404  id has no entry in the registry
 WorkspaceNotFoundError         404  workspaceDir gone
 WorkspaceIdConflictError       409  register({id}) collision
 WorkspacePathConflictError     409  workspaceDir already registered
 WorkspaceCorruptedError        500  workspaces row is unreadable
 RegistryError / RegistryCorruptedError / RegistrySchemaMismatchError
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

Test layout mirrors `src/`:

- **domain/**  value objects, aggregate (register / fromStored /
  rename / open).
- **application/**  command-handler tests on top of an in-memory
  ORM via `setupWorkspaceTestSubsystem`, plus an end-to-end module
  composition test asserting pipeline-behavior order.
- **infrastructure/**  `MikroWorkspaceRepository` and
  `MikroWorkspaceQueries` integration against `:memory:` SQLite,
  including `lastOpenedAt`-MRU ordering.
- **migration/**  legacy coordinator suite (still green; framework
  lives under `src/legacy/migration/` until phase 3 swaps it for the
  MikroORM migrator end-to-end).
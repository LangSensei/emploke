/**
 * @emploke/workspace — DDD+CQRS workspace context on MikroORM.
 *
 * A *workspace* is the user-chosen working directory that holds
 * emploke's per-workspace state (per-workspace SQLite DB at
 * `<workspaceDir>/workspace.db`, plus agent workdirs under `sessions/`
 * and `tasks/`). Catalog content (agents/skills/mcps) lives inside
 * `workspace.db` as BLOB rows, NOT as files on disk — the workspace
 * folder has no `catalog/` subdirectory. Each workspace is identified
 * by an opaque UUID `id` (the URL routing key) and lives at an
 * absolute filesystem `workspaceDir`. Its user-facing display name
 * and other metadata live in the global registry row (`global.db`),
 * NOT in the workspace folder.
 *
 * ## Phase 2 / ADR-3 surface (MikroORM)
 *
 * Persistence pivoted to MikroORM in Phase 2 (#139). Downstream
 * packages and the server's wire layer interact through:
 *
 *   - **Commands** (`Register/Rename/Unregister/SetCurrentWorkspaceCommand`)
 *     dispatched via `mediator.send(...)`. Each command's handler
 *     runs inside `TransactionBehavior`'s `em.transactional` wrapper,
 *     so the persistence + event dispatch are atomic.
 *   - **Queries** (`WorkspaceQueries` abstract class) injected via
 *     `@inject(WorkspaceQueries)`. Read-side projections backed by
 *     MikroORM's QueryBuilder; cross-context consumers MUST use this
 *     surface, never the repository.
 *   - **Composition** (`composeWorkspaceModule(container)`) called
 *     once by the server / CLI bootstrap. Requires `Mediator` AND
 *     `EntityManager` to be bound first.
 *   - **`WorkspaceEntities`** — the entity list to pass to
 *     `MikroORM.init({ entities: ... })`. Lets the composition root
 *     stay agnostic of the package's internal entity layout.
 *   - **`DomainEventSubscriber`** — re-exported so the composition
 *     root can pull it out of the container and pass into
 *     `MikroORM.init({ subscribers: ... })`.
 *
 * Everything else (the `Workspace` aggregate, `WorkspaceRepository`,
 * concrete handlers, `MikroWorkspaceRepository`, value objects beyond
 * the URL-routing `WorkspaceId`) is package-private. Tests that need
 * the aggregate or infrastructure directly import from
 * `@emploke/workspace/testing`.
 *
 * ## Why the legacy migration framework is still exported here
 *
 * The cross-package migration framework (`MigrationCoordinator`,
 * `runPkgMigrations`, etc.) is consumed by session/task/catalog and
 * the per-workspace `workspace.db` bootstrap. Phase 2 scope is the
 * workspace pkg's own DB (`global.db`) only — moving the migration
 * framework requires Phase 3+'s session/task/catalog refactors to
 * land first. Until then the framework continues to ship from
 * `@emploke/workspace` as a back-compat surface. Once Phase 5 lands
 * the cross-context refactor it may move to a dedicated
 * `@emploke/migration` pkg.
 *
 * The `workspaceLayout` helper, the `SESSIONS_SUBDIR` / `TASKS_SUBDIR`
 * constants, and the name validators (`isValidWorkspaceId` /
 * `assertValidDisplayName`) are pure utilities consumed by the server
 * pkg and downstream callers; exporting them is a workspace-pilot
 * pragmatic deviation from naming-conventions §5's strict list.
 */

// ── DDD + CQRS public surface (locked by issue #137 §5) ────────

// Side-effect import: registers TransactionBehavior on mediatr-ts's
// module-level pipelineBehaviors singleton at module load. The server
// composition root imports `composeWorkspaceModule` from this index,
// which transitively loads transaction-behavior.ts BEFORE the server
// constructs `new Mediator(...)` — so the mediator's resolver-prefetch
// loop finds the behaviour and auto-binds it.
import "./application/behaviors/transaction-behavior.js";

export { TransactionBehavior } from "./application/behaviors/transaction-behavior.js";
export { RegisterWorkspaceCommand } from "./application/commands/register-workspace.command.js";
export { RenameWorkspaceCommand } from "./application/commands/rename-workspace.command.js";
export { SetCurrentWorkspaceCommand } from "./application/commands/set-current-workspace.command.js";
export { UnregisterWorkspaceCommand } from "./application/commands/unregister-workspace.command.js";
export type { WorkspaceSummaryView } from "./application/queries/views/workspace-summary-view.js";
export type { WorkspaceView } from "./application/queries/views/workspace-view.js";
export { WorkspaceQueries } from "./application/queries/workspace-queries.js";
export { composeWorkspaceModule } from "./application/workspace.di.js";

export { WorkspaceId } from "./domain/aggregates/workspace/value-objects/workspace-id.js";

// ── MikroORM entity surface for the composition root ──────────

export { Workspace } from "./domain/aggregates/workspace/workspace.js";
export { DomainEventSubscriber } from "./infrastructure/domain-event-subscriber.js";
export { WorkspaceContext } from "./infrastructure/workspace-context.js";

/**
 * Entities owned by `@emploke/workspace`. Pass into
 * `MikroORM.init({ entities: WorkspaceEntities, ... })` so the
 * composition root stays agnostic of the package's internal entity
 * layout.
 */
export { WORKSPACE_ENTITIES } from "./infrastructure/workspace-entities.js";

// ── Typed errors callers may want to catch ────────────────────

export {
  RegistryCorruptedError,
  RegistryError,
  RegistryNotBootstrappedError,
  RegistrySchemaMismatchError,
  WorkspaceAlreadyExistsError,
  WorkspaceCorruptedError,
  WorkspaceError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
  WorkspaceNotFoundError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "./domain/exceptions/workspace-errors.js";

// ── Cross-package utilities (back-compat, see jsdoc above) ────

export {
  CURRENT_SCHEMA_VERSION,
  MAX_DISPLAY_NAME_LENGTH,
  SESSIONS_SUBDIR,
  TASKS_SUBDIR,
} from "./constants.js";
// ── Legacy migration framework (kept for session/task/catalog) ─
//
// Phase 2 / ADR-3 moves the WORKSPACE pkg's own storage onto
// MikroORM (see `Workspace` entity + `mikro-orm.config.ts`). The
// custom MigrationCoordinator is still shipped here because
// session/task/catalog and the per-workspace `workspace.db`
// bootstrap depend on it. Phase 3+ refactors those packages onto
// MikroORM, at which point this surface deletes.
//
// `WORKSPACE_MIGRATIONS` has been deleted — the workspace pkg's
// own schema now lives in `packages/workspace/migrations/`
// (MikroORM-managed). The `Migration` type and the coordinator
// are still useful for downstream packages.
export type { Migration, MigrationRunResult } from "./migration/index.js";
export {
  MigrationCoordinator,
  MigrationCycleError,
  MigrationDependencyMissingError,
  MigrationError,
  MigrationFailedError,
  MigrationRegisterError,
  MigrationVersionAheadError,
  runPkgMigrations,
  SchemaMetaMismatchError,
  SchemaMetaNotBootstrappedError,
  topoSort,
} from "./migration/index.js";
export { assertValidDisplayName, isValidDisplayName, isValidWorkspaceId } from "./names.js";
export { type WorkspaceLayout, workspaceLayout } from "./workspace-layout.js";

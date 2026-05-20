/**
 * @emploke/workspace — DDD+CQRS workspace context on MikroORM.
 *
 * A *workspace* is the user-chosen working directory that holds
 * emploke's per-workspace state (per-workspace SQLite DB at
 * `<workspaceDir>/workspace.db`, plus agent workdirs under `sessions/`
 * and `tasks/`). Catalog content (agents/skills/mcps) lives inside
 * `workspace.db` as BLOB rows, not as files on disk — the workspace
 * folder has no `catalog/` subdirectory. Each workspace is identified
 * by an opaque UUID `id` (the URL routing key) and lives at an
 * absolute filesystem `workspaceDir`. Its user-facing display name
 * and other metadata live in the global registry row (`global.db`),
 * not in the workspace folder.
 *
 * ## Public surface
 *
 * Downstream packages and the server's wire layer interact through:
 *
 *   - **Commands** (`Register/Rename/Unregister/OpenWorkspaceCommand`)
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
 *
 * Everything else (the `Workspace` aggregate, `WorkspaceRepository`,
 * concrete handlers, `MikroWorkspaceRepository`, value objects beyond
 * `WorkspaceId`) is package-private. Tests that need the aggregate or
 * infrastructure directly import from `@emploke/workspace/testing`.
 *
 * ## Legacy migration framework
 *
 * The `MigrationCoordinator` + `runPkgMigrations` re-exports below
 * come from `./legacy/migration/` and exist solely so session / task
 * / catalog can keep evolving their per-workspace SQLite schemas.
 * They will go away once those packages also pivot off the
 * hand-rolled framework. New code in this pkg must not depend on
 * them.
 */

// ── DDD + CQRS public surface ─────────────────────────────────

// Side-effect imports register pipeline behaviours on mediatr-ts's
// module-level pipelineBehaviors singleton at module load. mediatr-ts
// orders the chain LAST-pushed = outermost (`OrderedMappings.add`
// assigns each new entry an incrementing order; `getAll()` sorts
// descending). So we register innermost-first, outermost-last:
//
//   Transaction (innermost)  → opens em.transactional
//   Validation               → runs Zod / business pre-checks
//   Logging      (outermost) → debug-level entry/exit, warn on throw
//
// workspace.di.test.ts asserts the resulting execution order so a
// future import auto-sort can't silently break it.
import "./application/behaviors/transaction-behavior.js";
import "./application/behaviors/validation-behavior.js";
import "./application/behaviors/logging-behavior.js";

export { LOGGER, LoggingBehavior } from "./application/behaviors/logging-behavior.js";
export { TransactionBehavior } from "./application/behaviors/transaction-behavior.js";
export { ValidationBehavior } from "./application/behaviors/validation-behavior.js";
export { OpenWorkspaceCommand } from "./application/commands/open-workspace.command.js";
export { RegisterWorkspaceCommand } from "./application/commands/register-workspace.command.js";
export { RenameWorkspaceCommand } from "./application/commands/rename-workspace.command.js";
export { UnregisterWorkspaceCommand } from "./application/commands/unregister-workspace.command.js";
export type { WorkspaceSummaryView } from "./application/queries/views/workspace-summary-view.js";
export type { WorkspaceView } from "./application/queries/views/workspace-view.js";
export { WorkspaceQueries } from "./application/queries/workspace-queries.js";
export { CommandValidationError } from "./application/validations/command-validator.js";
export type {
  WorkspaceModuleHandle,
  WorkspaceModuleOptions,
} from "./application/workspace.di.js";
export { composeWorkspaceModule } from "./application/workspace.di.js";

export { WorkspaceId } from "./domain/aggregates/workspace/workspace-id.js";

// ── Internal infrastructure ─────────────────────────────────
//
// Internal types historically exported here are now reachable only
// via `@emploke/workspace/testing` for tests that drive the EM
// directly.

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
export { type WorkspaceLayout, workspaceLayout } from "./domain/workspace-layout.js";
// ── Legacy migration framework — see src/legacy/README.md ─────
//
// Still re-exported because session / task / catalog haven't pivoted
// off it yet. New code in this pkg must not depend on these.
export type { Migration, MigrationRunResult } from "./legacy/migration/index.js";
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
} from "./legacy/migration/index.js";

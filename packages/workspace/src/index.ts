/**
 * @emploke/workspace — DDD+CQRS workspace context.
 *
 * A *workspace* is the user-chosen working directory that holds
 * emploke's per-workspace state (per-workspace SQLite DB at
 * `<workspaceDir>/workspace.db`, plus agent workdirs under `sessions/`
 * and `tasks/`). Catalog content (agents/skills/mcps) lives inside
 * `workspace.db` as BLOB rows, NOT as files on disk — the workspace
 * folder has no `catalog/` subdirectory. Each workspace is identified
 * by an opaque UUID `id` (the URL routing key) and lives at an
 * absolute filesystem `workspaceDir`. Its user-facing display name and
 * other metadata live in the global registry row, NOT in the
 * workspace folder.
 *
 * ## Public API (locked by issue #137 §5)
 *
 * Domain consumers — typically other packages and the server's wire
 * layer — interact with workspaces through three surfaces:
 *
 *   - **Commands** (`Register/Rename/Unregister/SetCurrentWorkspaceCommand`)
 *     dispatched via `mediator.send(...)`. Cross-context callers
 *     `await` them; they return either `void` or `{ id }`.
 *   - **Queries** (`WorkspaceQueries` abstract class) injected via
 *     `@inject(WorkspaceQueries)`. Read-side projections — cross-context
 *     consumers MUST go through this surface, not the repository.
 *   - **Composition** (`composeWorkspaceModule(container)`) called once
 *     by the server / CLI bootstrap to register every binding above.
 *     Requires `Mediator` and `WorkspaceDb` to be bound first.
 *
 * Everything else (the `Workspace` aggregate, `WorkspaceRepository`,
 * concrete handlers, `SqliteWorkspaceRepository`, value objects beyond
 * the URL-routing `WorkspaceId`) is package-private. Tests that need
 * the SQLite repo / queries directly import from
 * `@emploke/workspace/testing`.
 *
 * ## Why migration-framework + layout-helpers are also exported here
 *
 * The migration framework (`MigrationCoordinator`, `runPkgMigrations`,
 * etc.) ships from `@emploke/workspace` for historical reasons —
 * downstream pkgs (session, task, catalog) and the server / CLI
 * bootstrap import it from this barrel today. Phase 1 keeps that
 * surface stable to limit blast radius to the workspace pkg.
 * Eventually it may move to a dedicated `@emploke/migration` pkg.
 *
 * The `workspaceLayout` helper, the `SESSIONS_SUBDIR` / `TASKS_SUBDIR`
 * constants, and the name validators (`isValidWorkspaceId` /
 * `assertValidDisplayName`) are pure utilities consumed by the server
 * pkg and downstream callers; exporting them is a workspace-pilot
 * pragmatic deviation from naming-conventions §5's strict list.
 */

// ── DDD + CQRS public surface (locked by issue #137 §5) ────────

export { RegisterWorkspaceCommand } from "./application/commands/register-workspace/register-workspace.command.js";
export { RenameWorkspaceCommand } from "./application/commands/rename-workspace/rename-workspace.command.js";
export { SetCurrentWorkspaceCommand } from "./application/commands/set-current-workspace/set-current-workspace.command.js";
export { UnregisterWorkspaceCommand } from "./application/commands/unregister-workspace/unregister-workspace.command.js";
export type { WorkspaceSummaryView } from "./application/queries/views/workspace-summary-view.js";
export type { WorkspaceView } from "./application/queries/views/workspace-view.js";
export { WorkspaceQueries } from "./application/queries/workspace-queries.js";
export { composeWorkspaceModule } from "./application/workspace.di.js";

export { WorkspaceId } from "./domain/value-objects/workspace-id.js";

// ── DI tokens for the composition root ────────────────────────

export { WorkspaceDb } from "./infrastructure/workspace-db.js";

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
} from "./domain/errors.js";

// ── Cross-package utilities (back-compat, see jsdoc above) ────

export {
  CURRENT_SCHEMA_VERSION,
  MAX_DISPLAY_NAME_LENGTH,
  SESSIONS_SUBDIR,
  TASKS_SUBDIR,
} from "./constants.js";
export { assertValidDisplayName, isValidDisplayName, isValidWorkspaceId } from "./names.js";
export { type WorkspaceLayout, workspaceLayout } from "./workspace-layout.js";

// ── Migration framework + workspace pkg migration chain ───────

export { WORKSPACE_MIGRATIONS } from "./infrastructure/migrations/index.js";
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

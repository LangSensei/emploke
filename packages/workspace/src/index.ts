/**
 * @emploke/workspace — per-project workspace abstraction.
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
 * Persistence is delegated to a `WorkspaceRepository`. The default
 * implementation `SqliteWorkspaceRepository` stores every workspace
 * record (id, workspaceDir, name, createdAt) as a single row in a
 * SQLite database at `$EMPLOKE_HOME/global.db`. Tests use the same
 * class with a `":memory:"` `DatabaseSync` (re-exported from
 * `@emploke/workspace/testing`); there is no separate in-memory
 * implementation since SQLite already provides that natively, matching
 * the pattern other SQLite-backed entity packages use.
 *
 * This package never spawns subprocesses, never touches `~/.copilot/`,
 * and has no opinions about runtimes — it's pure workspace state
 * management.
 */

export {
  CURRENT_SCHEMA_VERSION,
  MAX_DISPLAY_NAME_LENGTH,
  SESSIONS_SUBDIR,
  TASKS_SUBDIR,
} from "./constants.js";
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
} from "./errors.js";
export {
  type WorkspaceDeleteOpts,
  type WorkspaceInitOpts,
  WorkspaceManager,
  type WorkspaceUpdatePatch,
} from "./manager.js";
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
export { WORKSPACE_MIGRATIONS } from "./migrations/index.js";
export { assertValidDisplayName, isValidDisplayName, isValidWorkspaceId } from "./names.js";
export type { WorkspaceRepository } from "./repositories/repository.js";
export { SqliteWorkspaceRepository } from "./repositories/sqlite-workspace-repository.js";
export {
  Workspace,
  type WorkspaceLayout,
  workspaceLayout,
} from "./workspace-entity.js";

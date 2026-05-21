/**
 * @emploke/workspace — workspace registry on MikroORM.
 *
 * A *workspace* is the user-chosen working directory that holds
 * emploke's per-workspace state. Each workspace is identified by an
 * opaque UUID `id` (the URL routing key) and lives at an absolute
 * filesystem `workspaceDir`. Display name + metadata live in the
 * global registry row (`global.db`).
 */

export {
  composeWorkspaceModule,
  type WorkspaceModule,
  type WorkspaceModuleOptions,
} from "./compose.js";
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
  GLOBAL_DB_FILE,
  globalDbPath,
  WORKSPACES_PARENT_SUBDIR,
  type WorkspaceLayout,
  workspaceLayout,
  workspacesParentDir,
} from "./layout.js";
export {
  WorkspaceQueries,
  type WorkspaceSummaryView,
  type WorkspaceView,
} from "./queries.js";
export { WorkspaceService } from "./service.js";
export { InputValidationError } from "./validate.js";

/**
 * @emploke/workspace — per-project workspace abstraction.
 *
 * A *workspace* is the user-chosen working directory that holds
 * emploke's per-workspace state (sessions, tasks, catalog)
 * plus whatever the user has under it. Each workspace is
 * identified by an opaque UUID `id` (the URL routing key) and lives at
 * an absolute filesystem `workdir`. Its user-facing display name is
 * stored as part of the workspace's metadata and may be changed at any
 * time without breaking links.
 *
 * Persistence is delegated to a `WorkspaceRepository`. The default
 * implementation `FsWorkspaceRepository` stores the index at
 * `$EMPLOKE_HOME/workspaces.json` and the per-workspace metadata at
 * `<workdir>/workspace.json`. Tests can swap in `InMemoryWorkspaceRepository`
 * (re-exported from `@emploke/workspace/testing`).
 *
 * This package never spawns subprocesses, never touches `~/.copilot/`,
 * and has no opinions about runtimes — it's pure workspace state
 * management.
 */

export {
  CATALOG_SUBDIR,
  CURRENT_SCHEMA_VERSION,
  MAX_DISPLAY_NAME_LENGTH,
  SESSIONS_SUBDIR,
  TASKS_SUBDIR,
  WORKSPACE_FILE,
} from "./constants.js";
export {
  RegistryCorruptedError,
  RegistryError,
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
  WorkspaceSchemaMismatchError,
} from "./errors.js";
export {
  type WorkspaceDeleteOpts,
  type WorkspaceInitOpts,
  WorkspaceManager,
  type WorkspaceUpdatePatch,
} from "./manager.js";
export { assertValidDisplayName, isValidDisplayName, isValidWorkspaceId } from "./names.js";
export { FsWorkspaceRepository } from "./repositories/fs-workspace-repository.js";
export type { WorkspaceRepository } from "./repositories/repository.js";
export { type Workspace, type WorkspaceLayout, workspaceLayout } from "./types.js";

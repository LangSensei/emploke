/**
 * @emploke/workspace  per-project workspace abstraction + home-level registry.
 *
 * A *workspace* is the project-level root directory that holds emploke's
 * ephemeral artifacts (sessions, tasks, workflows, logs). Each workspace
 * is identified by an opaque UUID `id` (the URL routing key) and lives at
 * an absolute filesystem `path`. Its user-facing display name is stored
 * separately in `<dir>/workspace.json#name` and may be changed at any
 * time without breaking links.
 *
 * The *registry* is a single JSON file at `$EMPLOKE_HOME/workspaces.json`
 * that the server uses to enumerate known workspaces, resolve id  path,
 * and remember which workspace was last selected. The registry never
 * stores the display name  clients fetch it via `WorkspaceManager.open`
 * when they need to render the UI.
 *
 * This package never spawns subprocesses, never touches `~/.copilot/`, and
 * has no opinions about runtimes  it's pure file-layout management.
 */

export {
  CATALOG_SUBDIR,
  CURRENT_SCHEMA_VERSION,
  LOGS_SUBDIR,
  MAX_DISPLAY_NAME_LENGTH,
  SESSIONS_SUBDIR,
  TASKS_SUBDIR,
  WORKFLOWS_SUBDIR,
  WORKSPACE_FILE,
  WORKSPACE_LOCK_FILE,
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
export { type WorkspaceInitOpts, WorkspaceManager, type WorkspaceUpdatePatch } from "./manager.js";
export { assertValidDisplayName, isValidDisplayName, isValidWorkspaceId } from "./names.js";
export { type RegistryAddOpts, WorkspaceRegistry } from "./registry.js";
export type { RegistryEntry, RegistryFile, Workspace, WorkspaceMetadata } from "./types.js";

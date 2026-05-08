/**
 * @emploke/workspace — per-project workspace abstraction + home-level registry.
 *
 * A *workspace* is the project-level root directory that holds emploke's
 * ephemeral artifacts (sessions, tasks, workflows, logs). It is identified
 * by a kebab-case `name` in the URL routing and an absolute filesystem
 * `path` on disk.
 *
 * The *registry* is a single JSON file at `$EMPLOKE_HOME/workspaces.json`
 * that the server uses to enumerate known workspaces, look up a name → path,
 * and remember which workspace was last selected.
 *
 * This package never spawns subprocesses, never touches `~/.copilot/`, and
 * has no opinions about runtimes — it's pure file-layout management.
 */

export {
  CURRENT_SCHEMA_VERSION,
  LOGS_SUBDIR,
  MAX_NAME_LENGTH,
  SESSIONS_SUBDIR,
  TASKS_SUBDIR,
  WORKFLOWS_SUBDIR,
  WORKSPACE_FILE,
} from "./constants.js";
export {
  RegistryCorruptedError,
  RegistryError,
  WorkspaceAlreadyExistsError,
  WorkspaceCorruptedError,
  WorkspaceError,
  WorkspaceNameConflictError,
  WorkspaceNameInvalidError,
  WorkspaceNotFoundError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
  WorkspaceSchemaMismatchError,
} from "./errors.js";
export { type WorkspaceInitOpts, WorkspaceManager } from "./manager.js";
export { assertValidWorkspaceName, isValidWorkspaceName } from "./names.js";
export { type RegistryAddOpts, WorkspaceRegistry } from "./registry.js";
export type { RegistryEntry, RegistryFile, Workspace, WorkspaceMetadata } from "./types.js";

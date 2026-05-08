/** Filename of the per-workspace metadata file. */
export const WORKSPACE_FILE = "workspace.json";

/**
 * Filename of the per-workspace advisory lock used by `WorkspaceManager.init`
 * and `update`. Lives inside the workspace directory so each workspace has
 * its own lock; concurrent ops on different workspaces never contend.
 */
export const WORKSPACE_LOCK_FILE = ".workspace.lock";

/** Schema version for both `workspace.json` and `workspaces.json`. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Subdirectory of a workspace that holds session workdirs. */
export const SESSIONS_SUBDIR = "sessions";

/** Subdirectory of a workspace that holds the per-workspace catalog (skills, agents, mcps). */
export const CATALOG_SUBDIR = "catalog";

/** Subdirectory of a workspace that holds task records (placeholder; v1 unused). */
export const TASKS_SUBDIR = "tasks";

/** Subdirectory of a workspace that holds workflow records (placeholder). */
export const WORKFLOWS_SUBDIR = "workflows";

/** Subdirectory of a workspace for server-written log files (placeholder). */
export const LOGS_SUBDIR = "logs";

/** Maximum allowed length of the display name in `workspace.json`. */
export const MAX_DISPLAY_NAME_LENGTH = 64;

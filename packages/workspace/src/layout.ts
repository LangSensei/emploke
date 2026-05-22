import path from "node:path";

/**
 * Conventional sub-path layout under a workspace's `workspaceDir`.
 * Pure function; no fs side effects. Used by the workspace package's
 * own service and by downstream package managers
 * (`TaskService`, `SessionService`, `CatalogService`) to compute the
 * directories agents and runtimes use.
 */
export interface WorkspaceLayout {
  readonly sessions: string;
  readonly tasks: string;
  readonly workflows: string;
}

export function workspaceLayout(workspaceDir: string): WorkspaceLayout {
  const root = path.resolve(workspaceDir);
  return {
    sessions: path.join(root, "sessions"),
    tasks: path.join(root, "tasks"),
    workflows: path.join(root, "workflows"),
  };
}

// ─── Global (under EMPLOKE_HOME) ──────────────────────────────

/**
 * Filename (under `<home>`) for the global SQLite database. Holds the
 * workspace registry and other cross-workspace state. Per-workspace
 * data lives in each workspace's own `workspace.db`, not here.
 */
export const GLOBAL_DB_FILE = "global.db";

/**
 * Subdirectory (under `<home>`) where the server auto-allocates new
 * workspace directories when the user creates a workspace without
 * specifying a `workspaceDir`. Each auto-allocated workspace lives at
 * `<home>/workspaces/<uuid>/`.
 */
export const WORKSPACES_PARENT_SUBDIR = "workspaces";

/** Resolve `<home>/global.db`. */
export function globalDbPath(home: string): string {
  return path.join(home, GLOBAL_DB_FILE);
}

/** Resolve `<home>/workspaces/`. */
export function workspacesParentDir(home: string): string {
  return path.join(home, WORKSPACES_PARENT_SUBDIR);
}

import path from "node:path";

/**
 * Conventional sub-path layout under a workspace's `workspaceDir`.
 * Pure function; no fs side effects. Used by the workspace package's
 * own service and by downstream package managers
 * (`TaskService`, `SessionService`, `CatalogService`) to compute the
 * directories agents and runtimes use.
 *
 * `workflow` is currently unused inside this package: `register` does
 * not allocate it and `unregister({ purge: true })` does not remove it.
 * The `workflows/` directory is owned and resolved independently by
 * `@emploke/workflow` via its own `workflowRoot()` helper; the slot
 * here is retained only because the `WorkspaceLayout` type is in the
 * public barrel and narrowing it would be a breaking change. Do not
 * add new in-pkg consumers; route to `@emploke/workflow` instead. The
 * property name is singular while the directory is plural
 * (`workflows/`); a rename to `workflows` would also be a public-type
 * change and is intentionally deferred.
 */
export interface WorkspaceLayout {
  readonly sessions: string;
  readonly tasks: string;
  readonly workflow: string;
}

export function workspaceLayout(workspaceDir: string): WorkspaceLayout {
  const root = path.resolve(workspaceDir);
  return {
    sessions: path.join(root, "sessions"),
    tasks: path.join(root, "tasks"),
    workflow: path.join(root, "workflows"),
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

import path from "node:path";

/**
 * Conventional sub-path layout under a workspace's `workspaceDir`.
 *
 * `workflow` is currently unused inside this package: `register` does
 * not allocate it and `unregister({ purge: true })` does not remove it.
 * The slot is retained only because the `WorkspaceLayout` type is in
 * the public barrel and narrowing it would be a breaking change. Do
 * not add new in-pkg consumers; route to `@emploke/workflow` instead.
 * The property name is singular while the directory is plural
 * (`workflows/`); a rename to `workflows` would also be a public-type
 * change and is intentionally deferred.
 */
export interface WorkspaceLayout {
  readonly sessions: string;
  readonly tasks: string;
  readonly workflow: string;
}

/**
 * Compute the conventional sub-path layout under `workspaceDir`. Pure
 * function; no fs side effects. Used by `WorkspaceService` for the
 * `register` / `unregister({ purge: true })` FS work; also exported
 * so downstream pkgs can compute the same paths without importing
 * the service. Today no sibling pkg consumes it directly —
 * `@emploke/workflow` owns its `workflows/` subdir via its own
 * `workflowRoot()` helper, session/task compute their paths
 * independently, and catalog stores its data inside the per-workspace
 * `workspace.db` rather than under a subdirectory.
 */
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

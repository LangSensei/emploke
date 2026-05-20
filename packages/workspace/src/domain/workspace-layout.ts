import path from "node:path";

/**
 * Conventional sub-path layout under a workspace's `workspaceDir`.
 * Pure function; no fs side effects. Used by the workspace package's
 * own command handlers and by the downstream package managers
 * (`TaskManager`, `SessionManager`, `CatalogManager`) to compute the
 * directories agents and runtimes use.
 *
 * Kept as a standalone helper (rather than baking the paths into the
 * `Workspace` aggregate) so the aggregate stays clean — it has no
 * fs-knowledge fields beyond `workspaceDir`.
 */
export interface WorkspaceLayout {
  readonly sessions: string;
  readonly tasks: string;
}

/** Compute every fixed-name subdirectory under `workspaceDir`. */
export function workspaceLayout(workspaceDir: string): WorkspaceLayout {
  const root = path.resolve(workspaceDir);
  return {
    sessions: path.join(root, "sessions"),
    tasks: path.join(root, "tasks"),
  };
}

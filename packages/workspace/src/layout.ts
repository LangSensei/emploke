import path from "node:path";

/**
 * Conventional sub-path layout under a workspace's `workspaceDir`.
 * Pure function; no fs side effects. Used by the workspace package's
 * own service and by downstream package managers
 * (`TaskManager`, `SessionManager`, `CatalogManager`) to compute the
 * directories agents and runtimes use.
 */
export interface WorkspaceLayout {
  readonly sessions: string;
  readonly tasks: string;
}

export function workspaceLayout(workspaceDir: string): WorkspaceLayout {
  const root = path.resolve(workspaceDir);
  return {
    sessions: path.join(root, "sessions"),
    tasks: path.join(root, "tasks"),
  };
}

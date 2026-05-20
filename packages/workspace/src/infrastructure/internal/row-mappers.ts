import { WorkspaceCorruptedError } from "../../domain/errors.js";
import { Workspace } from "../../domain/workspace.js";

/**
 * Internal helper: shape of one row from the `workspaces` table.
 * Mirrors the v2 schema (`id`, `workspace_dir`, `name`, `created_at`,
 * `registered_at`, `last_opened_at`). The registry-only timing
 * columns (`registered_at`, `last_opened_at`) live OUTSIDE the
 * aggregate today — they're maintained by the repository as side
 * effects of `create` / `setCurrent` rather than as aggregate state.
 */
export interface WorkspaceRow {
  id: string;
  workspace_dir: string;
  name: string;
  created_at: string;
  registered_at: string;
  last_opened_at: string | null;
}

/**
 * Hydrate a `WorkspaceRow` into a `Workspace` aggregate. Validation
 * lives inside `Workspace.fromStored`, which raises a typed
 * {@link WorkspaceCorruptedError} that carries the on-disk
 * `workspace_dir` for operator triage.
 */
export function rowToWorkspace(row: WorkspaceRow): Workspace {
  return Workspace.fromStored({
    id: row.id,
    workspaceDir: row.workspace_dir,
    name: row.name,
    createdAt: row.created_at,
  });
}

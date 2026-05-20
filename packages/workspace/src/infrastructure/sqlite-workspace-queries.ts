import { inject, injectable } from "inversify";
import type { WorkspaceSummaryView } from "../application/queries/views/workspace-summary-view.js";
import type { WorkspaceView } from "../application/queries/views/workspace-view.js";
import { WorkspaceQueries } from "../application/queries/workspace-queries.js";
import { isValidWorkspaceId } from "../names.js";
import { WorkspaceDb } from "./workspace-db.js";

/**
 * Read-side projection over the same `<EMPLOKE_HOME>/global.db` the
 * repository writes to. CQRS-purists would put projections on a
 * separate denormalised store; emploke's read volume is low enough
 * that one SQLite source is fine.
 *
 * Returns plain `WorkspaceView` / `WorkspaceSummaryView` records (no
 * aggregate construction) so cross-context consumers don't accidentally
 * hold a `Workspace` aggregate (forbidden by naming-conventions §8.2).
 */
@injectable()
export class SqliteWorkspaceQueries extends WorkspaceQueries {
  constructor(@inject(WorkspaceDb) private readonly db: WorkspaceDb) {
    super();
  }

  override async getById(id: string): Promise<WorkspaceView | null> {
    if (!isValidWorkspaceId(id)) return null;
    const row = this.db
      .prepare(
        `SELECT id, workspace_dir, name, created_at
           FROM workspaces WHERE id = ?`,
      )
      .get(id) as
      | { id: string; workspace_dir: string; name: string; created_at: string }
      | undefined;
    return row ? rowToView(row) : null;
  }

  override async list(): Promise<WorkspaceSummaryView[]> {
    const rows = this.db
      .prepare(
        `SELECT id, name, workspace_dir, created_at
           FROM workspaces ORDER BY registered_at`,
      )
      .all() as Array<{
      id: string;
      name: string;
      workspace_dir: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      workspaceDir: row.workspace_dir,
      createdAt: row.created_at,
    }));
  }

  override async getCurrent(): Promise<WorkspaceView | null> {
    const id = await this.getCurrentId();
    if (!id) return null;
    // Selected workspace may have been deleted; `getById` returns
    // null in that case (the cleanup keystroke for the stale pointer
    // happens in the repo's delete()).
    return this.getById(id);
  }

  override async getCurrentId(): Promise<string | null> {
    const row = this.db
      .prepare("SELECT value FROM global_state WHERE key = ?")
      .get("current_workspace_id") as { value: string } | undefined;
    return row?.value ?? null;
  }
}

function rowToView(row: {
  id: string;
  workspace_dir: string;
  name: string;
  created_at: string;
}): WorkspaceView {
  return {
    id: row.id,
    workspaceDir: row.workspace_dir,
    name: row.name,
    createdAt: row.created_at,
  };
}

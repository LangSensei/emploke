import { inject, injectable } from "inversify";
import { Workspace } from "../../domain/aggregates/workspace/workspace.js";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";
import { isValidWorkspaceId } from "../../names.js";
import type { WorkspaceSummaryView } from "./views/workspace-summary-view.js";
import type { WorkspaceView } from "./views/workspace-view.js";
import { WorkspaceQueries } from "./workspace-queries.js";

/**
 * Read-side projection over the same `<EMPLOKE_HOME>/global.db` the
 * repository writes to.
 *
 * Phase 2 / ADR-3: backed by MikroORM's {@link EntityManager}.
 * QueryBuilder is the default for list/get because it keeps the
 * read-side projection a pure SELECT (no entity hydration / event
 * accumulation overhead — neither would be wrong, just wasted work
 * since the read view is a flat record). The single raw-SQL escape
 * hatch is `getCurrent` / `getCurrentId`, which joins the
 * `global_state` table that is not yet a MikroORM entity (see
 * `MikroWorkspaceRepository` for the rationale).
 *
 * The injected `EntityManager` is the abstract `@mikro-orm/core`
 * surface; QueryBuilder + raw SQL live on the SQL-specific
 * `SqlEntityManager` (from `@mikro-orm/knex`). The cast is sound
 * because workspace pkg only ever runs against a SQL driver.
 *
 * Returns plain `WorkspaceView` / `WorkspaceSummaryView` records (no
 * aggregate construction) so cross-context consumers don't accidentally
 * hold a `Workspace` aggregate (forbidden by naming-conventions §8.2).
 */
@injectable()
export class MikroWorkspaceQueries extends WorkspaceQueries {
  constructor(@inject(WorkspaceContext) private readonly ctx: WorkspaceContext) {
    super();
  }

  override async getById(id: string): Promise<WorkspaceView | null> {
    if (!isValidWorkspaceId(id)) return null;
    const row = (await this.ctx.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id", "w.workspaceDir", "w.name", "w.createdAt"])
      .where({ id })
      .execute("get")) as WorkspaceRowProjection | null;
    return row ? rowToView(row) : null;
  }

  override async list(): Promise<WorkspaceSummaryView[]> {
    const rows = (await this.ctx.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id", "w.workspaceDir", "w.name", "w.createdAt"])
      .execute("all")) as WorkspaceRowProjection[];
    return rows.map(rowToView);
  }

  override async getCurrent(): Promise<WorkspaceView | null> {
    const id = await this.getCurrentId();
    if (!id) return null;
    // Selected workspace may have been deleted; `getById` returns
    // null in that case (the cleanup keystroke for the stale pointer
    // happens in `MikroWorkspaceRepository.delete()`).
    return this.getById(id);
  }

  override async getCurrentId(): Promise<string | null> {
    const rows = (await this.ctx.sqlEm.execute("SELECT value FROM global_state WHERE key = ?", [
      "current_workspace_id",
    ])) as Array<{ value: string }>;
    return rows[0]?.value ?? null;
  }
}

/** Camel-case projection shape returned by QueryBuilder.execute('get'/'all'). */
interface WorkspaceRowProjection {
  id: string;
  workspaceDir: string;
  name: string;
  createdAt: string;
}

function rowToView(row: WorkspaceRowProjection): WorkspaceView {
  return {
    id: row.id,
    workspaceDir: row.workspaceDir,
    name: row.name,
    createdAt: row.createdAt,
  };
}

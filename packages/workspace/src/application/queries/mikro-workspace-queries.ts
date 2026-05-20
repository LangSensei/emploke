import { inject, injectable } from "inversify";
import { WorkspaceId } from "../../domain/aggregates/workspace/value-objects/workspace-id.js";
import { Workspace } from "../../domain/aggregates/workspace/workspace.js";
import { GLOBAL_STATE_KEYS, GlobalState } from "../../domain/global-state.js";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";

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
 * since the read view is a flat record). The current-workspace pointer
 * lookup goes through the {@link GlobalState} entity (Phase 2 polish
 * P1-5).
 *
 * The injected `EntityManager` is the abstract `@mikro-orm/core`
 * surface; QueryBuilder lives on the SQL-specific `SqlEntityManager`
 * (from `@mikro-orm/knex`). The cast on `ctx.sqlEm` is sound because
 * workspace pkg only ever runs against a SQL driver.
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
    if (!WorkspaceId.isValid(id)) return null;
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
    // null in that case (cleanup of the stale pointer happens in
    // ClearCurrentOnUnregisterDomainEventHandler reacting to WorkspaceUnregistered).
    return this.getById(id);
  }

  override async getCurrentId(): Promise<string | null> {
    const pointer = await this.ctx.em.findOne(GlobalState, {
      key: GLOBAL_STATE_KEYS.CURRENT_WORKSPACE_ID,
    });
    return pointer?.value ?? null;
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

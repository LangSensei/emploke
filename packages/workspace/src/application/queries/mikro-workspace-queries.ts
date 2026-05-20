import { inject, injectable } from "inversify";
import { Workspace } from "../../domain/aggregates/workspace/workspace.js";
import { WorkspaceId } from "../../domain/aggregates/workspace/workspace-id.js";
import { WorkspaceContext } from "../../infrastructure/workspace-context.js";

import type { WorkspaceSummaryView } from "./views/workspace-summary-view.js";
import type { WorkspaceView } from "./views/workspace-view.js";
import { WorkspaceQueries } from "./workspace-queries.js";

/**
 * Read-side projection over the same `<EMPLOKE_HOME>/global.db` the
 * repository writes to.
 *
 * Backed by MikroORM's QueryBuilder against the `Workspace` table. The
 * "current workspace" concept is collapsed onto `last_opened_at`:
 * `getLastOpened` / `getLastOpenedId` return the row with the
 * greatest `last_opened_at` (NULLs sorted last, ties broken by
 * `created_at` to keep results deterministic in tests).
 *
 * The injected `EntityManager` is the abstract `@mikro-orm/core`
 * surface; QueryBuilder lives on the SQL-specific `SqlEntityManager`
 * (from `@mikro-orm/knex`). The cast on `ctx.sqlEm` is sound because
 * workspace pkg only ever runs against a SQL driver.
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
      .select(["w.id", "w.workspaceDir", "w.name", "w.createdAt", "w.lastOpenedAt"])
      .where({ id })
      .execute("get")) as WorkspaceRowProjection | null;
    return row ? rowToView(row) : null;
  }

  override async list(): Promise<WorkspaceSummaryView[]> {
    // SQLite default-sorts NULL last in DESC order, so a plain
    // `ORDER BY last_opened_at DESC` already puts never-opened rows
    // at the tail. `created_at DESC` is the deterministic tiebreak
    // (relevant when two rows share the same `lastOpenedAt`, e.g.
    // never-opened fixtures registered in quick succession).
    const rows = (await this.ctx.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id", "w.workspaceDir", "w.name", "w.createdAt", "w.lastOpenedAt"])
      .orderBy({ "w.last_opened_at": "DESC", "w.created_at": "DESC" })
      .execute("all")) as WorkspaceRowProjection[];
    return rows.map(rowToView);
  }

  override async getLastOpened(): Promise<WorkspaceView | null> {
    const row = (await this.ctx.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id", "w.workspaceDir", "w.name", "w.createdAt", "w.lastOpenedAt"])
      .where({ lastOpenedAt: { $ne: null } })
      .orderBy({ "w.last_opened_at": "DESC", "w.created_at": "DESC" })
      .limit(1)
      .execute("get")) as WorkspaceRowProjection | null;
    return row ? rowToView(row) : null;
  }

  override async getLastOpenedId(): Promise<string | null> {
    const row = (await this.ctx.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id"])
      .where({ lastOpenedAt: { $ne: null } })
      .orderBy({ "w.last_opened_at": "DESC", "w.created_at": "DESC" })
      .limit(1)
      .execute("get")) as { id: string } | null;
    return row?.id ?? null;
  }
}

/** Camel-case projection shape returned by QueryBuilder.execute('get'/'all'). */
interface WorkspaceRowProjection {
  id: string;
  workspaceDir: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string | null;
}

function rowToView(row: WorkspaceRowProjection): WorkspaceView {
  return {
    id: row.id,
    workspaceDir: row.workspaceDir,
    name: row.name,
    createdAt: row.createdAt,
    lastOpenedAt: row.lastOpenedAt ?? null,
  };
}

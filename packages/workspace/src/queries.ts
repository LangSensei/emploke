import type { SqlEntityManager } from "@mikro-orm/better-sqlite";
import type { EntityManager } from "@mikro-orm/core";
import { Workspace } from "./entity.js";
import { isValidWorkspaceId } from "./validators.js";

/**
 * Read-side view of a single workspace. Stable wire shape for
 * cross-context consumers (server, CLI, dashboard).
 */
export interface WorkspaceView {
  readonly id: string;
  readonly workspaceDir: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string | null;
}

/** Summary projection over the workspace list. Identical fields to `WorkspaceView` today. */
export type WorkspaceSummaryView = WorkspaceView;

/**
 * Read-side queries over the workspace table. Backed by MikroORM's
 * QueryBuilder; safe for cross-context callers (no aggregate
 * invariants to violate).
 *
 * Plain class — no DI token, no abstract base. Consumers receive an
 * instance from `composeWorkspaceModule`.
 */
export class WorkspaceQueries {
  constructor(private readonly em: EntityManager) {}

  private get sqlEm(): SqlEntityManager {
    return this.em as unknown as SqlEntityManager;
  }

  async getById(id: string): Promise<WorkspaceView | null> {
    if (!isValidWorkspaceId(id)) return null;
    const row = (await this.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id", "w.workspaceDir", "w.name", "w.createdAt", "w.lastOpenedAt"])
      .where({ id })
      .execute("get")) as WorkspaceRowProjection | null;
    return row ? rowToView(row) : null;
  }

  /**
   * Every workspace, ordered by `lastOpenedAt DESC NULLS LAST` then
   * `createdAt DESC` for deterministic tiebreaks.
   */
  async list(): Promise<WorkspaceSummaryView[]> {
    const rows = (await this.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id", "w.workspaceDir", "w.name", "w.createdAt", "w.lastOpenedAt"])
      .orderBy({ "w.last_opened_at": "DESC", "w.created_at": "DESC" })
      .execute("all")) as WorkspaceRowProjection[];
    return rows.map(rowToView);
  }

  /** Most-recently-opened workspace (full view). */
  async getLastOpened(): Promise<WorkspaceView | null> {
    const row = (await this.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id", "w.workspaceDir", "w.name", "w.createdAt", "w.lastOpenedAt"])
      .where({ lastOpenedAt: { $ne: null } })
      .orderBy({ "w.last_opened_at": "DESC", "w.created_at": "DESC" })
      .limit(1)
      .execute("get")) as WorkspaceRowProjection | null;
    return row ? rowToView(row) : null;
  }

  /** Just the id of the most-recently-opened workspace. */
  async getLastOpenedId(): Promise<string | null> {
    const row = (await this.sqlEm
      .createQueryBuilder(Workspace, "w")
      .select(["w.id"])
      .where({ lastOpenedAt: { $ne: null } })
      .orderBy({ "w.last_opened_at": "DESC", "w.created_at": "DESC" })
      .limit(1)
      .execute("get")) as { id: string } | null;
    return row?.id ?? null;
  }
}

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

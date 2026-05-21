import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import { workspaces } from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/** Wire-shape projection of a workspace row, returned by the queries layer. */
export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly workspaceDir: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
}

export type WorkspaceSummaryView = WorkspaceView;

/**
 * Drizzle-backed read projections for the workspace registry.
 */
export class WorkspaceQueries {
  constructor(private readonly db: Db) {}

  async getById(id: string): Promise<WorkspaceView | null> {
    const row = this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    return row ? toView(row) : null;
  }

  async list(): Promise<WorkspaceSummaryView[]> {
    const rows = this.db.select().from(workspaces).orderBy(desc(workspaces.lastOpenedAt)).all();
    return rows.map(toView);
  }

  async getLastOpened(): Promise<WorkspaceView | null> {
    const row = this.db
      .select()
      .from(workspaces)
      .orderBy(desc(workspaces.lastOpenedAt))
      .limit(1)
      .get();
    return row ? toView(row) : null;
  }

  async getLastOpenedId(): Promise<string | null> {
    const row = this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .orderBy(desc(workspaces.lastOpenedAt))
      .limit(1)
      .get();
    return row?.id ?? null;
  }
}

function toView(row: typeof workspaces.$inferSelect): WorkspaceView {
  return {
    id: row.id,
    name: row.name,
    workspaceDir: row.workspaceDir,
    createdAt: row.createdAt,
    lastOpenedAt: row.lastOpenedAt ?? row.createdAt,
  };
}

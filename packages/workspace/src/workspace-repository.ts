import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import { type NewWorkspace, type Workspace, workspaces } from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed workspace repository. Sync at the SQLite layer
 * (better-sqlite3 driver). Repository methods are typed as
 * `Promise<...>` so async service signatures stay unchanged.
 */
export class WorkspaceRepository {
  private readonly db: Db;

  constructor(opts: { db: Db }) {
    this.db = opts.db;
  }

  async findById(id: string): Promise<Workspace | undefined> {
    return this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  }

  async findByPath(workspaceDir: string): Promise<Workspace | undefined> {
    return this.db.select().from(workspaces).where(eq(workspaces.workspaceDir, workspaceDir)).get();
  }

  async insert(row: NewWorkspace): Promise<void> {
    this.db.insert(workspaces).values(row).run();
  }

  async update(
    id: string,
    patch: Partial<Pick<Workspace, "name" | "lastOpenedAt">>,
  ): Promise<void> {
    this.db.update(workspaces).set(patch).where(eq(workspaces.id, id)).run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(workspaces).where(eq(workspaces.id, id)).run();
  }
}

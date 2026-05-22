import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import { type NewWorkspaceRow, type WorkspaceRow, workspaces } from "./schema.js";
import type { Workspace } from "./types.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed workspace repository. Sync at the SQLite layer
 * (better-sqlite3 driver). Repository methods are typed as
 * `Promise<...>` so async service signatures stay unchanged.
 *
 * **DTO at the boundary:** every public method returns the
 * pkg-owned {@link Workspace} DTO, never the Drizzle-inferred
 * {@link WorkspaceRow} type. The `WorkspaceRow` shape exists only as
 * an implementation detail of the persistence layer — exposing it
 * would leak the ORM contract upward and re-introduce the
 * `lastOpenedAt: string | null` vs `string` type lie that the
 * dedicated DTO was designed to eliminate. Pattern mirrored from
 * Codex's `ThreadStore` trait (see `docs/pkg-template.md`).
 */
export class WorkspaceRepository {
  private readonly db: Db;

  constructor(opts: { db: Db }) {
    this.db = opts.db;
  }

  async findById(id: string): Promise<Workspace | undefined> {
    const row = this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    return row ? rowToDto(row) : undefined;
  }

  async findByPath(workspaceDir: string): Promise<Workspace | undefined> {
    const row = this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.workspaceDir, workspaceDir))
      .get();
    return row ? rowToDto(row) : undefined;
  }

  async findAllByLastOpened(): Promise<Workspace[]> {
    const rows = this.db.select().from(workspaces).orderBy(desc(workspaces.lastOpenedAt)).all();
    return rows.map(rowToDto);
  }

  async findLastOpened(): Promise<Workspace | undefined> {
    const row = this.db
      .select()
      .from(workspaces)
      .orderBy(desc(workspaces.lastOpenedAt))
      .limit(1)
      .get();
    return row ? rowToDto(row) : undefined;
  }

  async findLastOpenedId(): Promise<string | undefined> {
    const row = this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .orderBy(desc(workspaces.lastOpenedAt))
      .limit(1)
      .get();
    return row?.id;
  }

  async insert(row: NewWorkspaceRow): Promise<void> {
    this.db.insert(workspaces).values(row).run();
  }

  async update(
    id: string,
    patch: Partial<Pick<WorkspaceRow, "name" | "lastOpenedAt">>,
  ): Promise<void> {
    this.db.update(workspaces).set(patch).where(eq(workspaces.id, id)).run();
  }

  async delete(id: string): Promise<void> {
    this.db.delete(workspaces).where(eq(workspaces.id, id)).run();
  }
}

/**
 * Project a persisted row to the public {@link Workspace} DTO. Module-
 * private — the only legitimate caller is `WorkspaceRepository`. Lives
 * here (not in service.ts) so the DTO contract and the row contract
 * are reconciled at the same boundary: schema change -> repo change
 * -> projection update -> DTO unchanged.
 *
 * Note `lastOpenedAt`: the column is nullable (a never-opened
 * workspace has no value) but the DTO normalises null to
 * `createdAt`, since "the workspace was opened at registration time"
 * is the convention every consumer relies on for sort/display.
 */
function rowToDto(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    workspaceDir: row.workspaceDir,
    createdAt: row.createdAt,
    lastOpenedAt: row.lastOpenedAt ?? row.createdAt,
  };
}

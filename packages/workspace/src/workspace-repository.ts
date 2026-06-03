import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import { type NewWorkspaceRow, type WorkspaceRow, workspaces } from "./schema.js";
import type { WorkspaceEntity } from "./workspace-entity.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed workspace repository. Sync at the SQLite layer
 * (better-sqlite3 driver). Repository methods are typed as
 * `Promise<...>` so async service signatures stay unchanged.
 *
 * **Entity at the boundary:** every public read method returns the
 * pkg-owned {@link WorkspaceEntity} type, never the Drizzle-inferred
 * {@link WorkspaceRow}. Today `WorkspaceEntity` is structurally
 * identical to `WorkspaceRow`, so TypeScript's structural typing
 * accepts the row directly — no explicit projection helper needed.
 *
 * The naming separation is contractual: `WorkspaceRow` is a Drizzle
 * implementation detail (changes when the ORM does); `WorkspaceEntity`
 * is the pkg-owned domain shape (changes when we want it to). The
 * moment Row gains a column we don't want in Entity (e.g. a
 * `deleted_at` for soft-delete), reintroduce a `rowToEntity`
 * projection here and `WorkspaceEntity` stops being assignable from
 * the row directly. Until then, the type-level alias is enough.
 *
 * Service layer maps `WorkspaceEntity` → wire `Workspace` DTO by
 * coalescing the nullable `lastOpenedAt` to `createdAt` (so DTO
 * consumers never see `null`).
 */
export class WorkspaceRepository {
  private readonly db: Db;

  constructor(opts: { db: Db }) {
    this.db = opts.db;
  }

  /**
   * ORDER BY chain shared by all "last opened" reads
   * (`findAllByLastOpened`, `findLastOpened`, `findLastOpenedId`).
   *
   * - `lastOpenedAt DESC` is the primary sort and matches what
   *   `getLastOpened` exposes.
   * - `createdAt DESC` is the secondary tiebreaker for ISO-8601-ms
   *   collisions (two registers landing in the same millisecond).
   * - `id ASC` is the final deterministic fallback.
   *
   * Tests that need "second register wins" insert a small `setTimeout`
   * between back-to-back registers to guarantee a strictly greater
   * `lastOpenedAt`, because identical millisecond stamps collapse to
   * id-ASC ordering — which returns the *first* registered id.
   */
  private static lastOpenedOrderBy() {
    return [desc(workspaces.lastOpenedAt), desc(workspaces.createdAt), workspaces.id];
  }

  async findById(id: string): Promise<WorkspaceEntity | undefined> {
    return this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  }

  async findByPath(workspaceDir: string): Promise<WorkspaceEntity | undefined> {
    return this.db.select().from(workspaces).where(eq(workspaces.workspaceDir, workspaceDir)).get();
  }

  async findAllByLastOpened(): Promise<WorkspaceEntity[]> {
    return this.db
      .select()
      .from(workspaces)
      .orderBy(...WorkspaceRepository.lastOpenedOrderBy())
      .all();
  }

  async findLastOpened(): Promise<WorkspaceEntity | undefined> {
    return this.db
      .select()
      .from(workspaces)
      .orderBy(...WorkspaceRepository.lastOpenedOrderBy())
      .limit(1)
      .get();
  }

  async findLastOpenedId(): Promise<string | undefined> {
    const row = this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .orderBy(...WorkspaceRepository.lastOpenedOrderBy())
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

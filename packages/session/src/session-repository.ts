import { and, eq, gte, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { InvalidSessionIdError } from "./errors.js";
import type * as schema from "./schema.js";
import { sessions } from "./schema.js";
import type { SessionEntity } from "./session-entity.js";
import { SESSION_ID_RE } from "./validate.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface ListSessionStateOpts {
  readonly createdSince?: string;
  readonly agent?: string;
}

/**
 * Drizzle-backed CRUD for the `sessions` table. Defense-in-depth: every
 * public method validates `id` against `SESSION_ID_RE` before reaching
 * the DB. The validation keeps the "sessions namespace, not arbitrary
 * keys" contract explicit.
 *
 * **Entity at the boundary:** read methods return the pkg-owned
 * {@link SessionEntity} (persisted slice). Today the entity is
 * structurally identical to the Drizzle row, so the row assigns
 * directly via TypeScript structural typing — no explicit projection
 * helper. The naming separation is contractual; reintroduce a
 * `rowToEntity` projection if Row ever gains a column we don't
 * want in Entity.
 *
 * The service composes the wire-shape
 * {@link import("./types.js").Session} DTO by adding `workdir`
 * (computed from layout) and live `lastActiveAt` / `preview` (read
 * from the runtime).
 */
export class SessionRepository {
  private readonly db: Db;

  constructor(opts: { db: Db }) {
    this.db = opts.db;
  }

  /**
   * `async` even though the underlying drizzle better-sqlite3 driver
   * is synchronous: the repository contract is async across all pkgs
   * (so services can `await` uniformly) and to leave room for swapping
   * the driver later without a breaking signature change. Microbench
   * cost of `async` over sync return is negligible at the
   * 10s-of-queries/sec scale this repo handles.
   */
  async findById(id: string): Promise<SessionEntity | undefined> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  async insert(row: {
    id: string;
    agent: string;
    runtime: string;
    createdAt: string;
    runtimeSessionId: string | null;
    lastLaunchMode?: "local" | "remote" | null;
  }): Promise<void> {
    if (!SESSION_ID_RE.test(row.id)) throw new InvalidSessionIdError(row.id);
    this.db
      .insert(sessions)
      .values({
        id: row.id,
        agent: row.agent,
        runtime: row.runtime,
        createdAt: row.createdAt,
        runtimeSessionId: row.runtimeSessionId,
        lastLaunchMode: row.lastLaunchMode ?? null,
      })
      .run();
  }

  /** Atomically update only the `lastLaunchMode` column. */
  async patchLastLaunchMode(id: string, mode: "local" | "remote"): Promise<void> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    this.db.update(sessions).set({ lastLaunchMode: mode }).where(eq(sessions.id, id)).run();
  }

  /** Idempotent delete. */
  async delete(id: string): Promise<void> {
    if (!SESSION_ID_RE.test(id)) return;
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  async list(opts: ListSessionStateOpts = {}): Promise<SessionEntity[]> {
    const filters: SQL[] = [];
    if (opts.createdSince !== undefined) filters.push(gte(sessions.createdAt, opts.createdSince));
    if (opts.agent !== undefined) filters.push(eq(sessions.agent, opts.agent));
    const query = this.db.select().from(sessions);
    return filters.length > 0 ? query.where(and(...filters)).all() : query.all();
  }
}

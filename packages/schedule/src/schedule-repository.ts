import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { ScheduleNotFoundError } from "./errors.js";
import { ScheduleEntity } from "./schedule-entity.js";
import type * as schema from "./schema.js";
import { type ScheduleRow, schedules } from "./schema.js";
import type { ListScheduleOpts } from "./types.js";
import { assertValidScheduleId } from "./validate.js";

const silentLogger: Logger = pino({ level: "silent" });

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed CRUD for the `schedules` table. Private to the pkg:
 * external callers go through {@link ScheduleService}.
 *
 * Defense-in-depth id validation lives here so the table grammar is
 * enforced even if a future caller forgets to validate at the
 * boundary.
 */
export class ScheduleRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    void this.logger;
  }

  async read(id: string): Promise<ScheduleEntity | null> {
    assertValidScheduleId(id);
    const row = this.db.select().from(schedules).where(eq(schedules.id, id)).get();
    if (row === undefined) return null;
    return rowToEntity(row);
  }

  async list(opts: ListScheduleOpts = {}): Promise<readonly ScheduleEntity[]> {
    const conditions = [];
    if (opts.enabled !== undefined) {
      conditions.push(eq(schedules.enabled, opts.enabled));
    }
    if (opts.agent !== undefined) {
      conditions.push(eq(schedules.targetAgent, opts.agent));
    }
    const baseQuery = this.db.select().from(schedules);
    const whereQuery = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
    // ORDER BY next_fire_at ASC NULLS LAST. SQLite sorts NULLs first
    // by default; the raw `sql` modifier covers the wire contract
    // from the RFC (newest-armed first, never-armed last).
    const rows = whereQuery.orderBy(sql`${schedules.nextFireAt} ASC NULLS LAST`).all();
    return rows.map(rowToEntity);
  }

  async insert(entity: ScheduleEntity): Promise<void> {
    const row = entity.toRow();
    assertValidScheduleId(row.id);
    this.db.insert(schedules).values(row).run();
  }

  async update(entity: ScheduleEntity): Promise<void> {
    const row = entity.toRow();
    assertValidScheduleId(row.id);
    const result = this.db.update(schedules).set(row).where(eq(schedules.id, row.id)).run();
    if (result.changes === 0) {
      throw new ScheduleNotFoundError(row.id);
    }
  }

  async delete(id: string): Promise<void> {
    assertValidScheduleId(id);
    const result = this.db.delete(schedules).where(eq(schedules.id, id)).run();
    if (result.changes === 0) {
      throw new ScheduleNotFoundError(id);
    }
  }

  /**
   * Targeted update of just `last_fired_at` + `next_fire_at`. Avoids
   * serialising the entire `target_json` payload on every fire — the
   * fire path is the hot loop, the rest of the row is immutable for
   * its duration.
   */
  async recordFired(id: string, firedAt: string, nextFireAt: string | null): Promise<void> {
    assertValidScheduleId(id);
    const result = this.db
      .update(schedules)
      .set({ lastFiredAt: firedAt, nextFireAt })
      .where(eq(schedules.id, id))
      .run();
    if (result.changes === 0) {
      throw new ScheduleNotFoundError(id);
    }
  }
}

function rowToEntity(row: ScheduleRow): ScheduleEntity {
  return ScheduleEntity.fromStored(row);
}

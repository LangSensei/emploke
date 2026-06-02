import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { assertValidJsonPath } from "./_helpers.js";
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
 * The repository is intentionally kind-blind. The `list({ kind,
 * dataEquals })` opts are generic: callers that want a kind-specific
 * filter compose them (e.g. the server route maps the wire `?agent=`
 * query to `{ kind: "task", dataEquals: { path: "$.agent", value }}`).
 * The `target_kind = 'task'` predicate ALONG WITH the matching
 * `json_extract(target_json, '$.agent') = ?` predicate is what
 * engages SQLite's partial index `schedules_target_agent_idx`
 * (defined `WHERE target_kind = 'task'`); future kinds add their
 * own partial indexes when they need them.
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
    if (opts.kind !== undefined) {
      conditions.push(eq(schedules.targetKind, opts.kind));
    }
    if (opts.dataEquals !== undefined) {
      // SQL-injection defence: the path is string-concatenated into
      // the `json_extract` first argument because Drizzle's `sql`
      // template only parameterises `?` placeholders, not the path
      // expression. Reject anything that doesn't match the
      // `^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$` grammar BEFORE building
      // the fragment.
      assertValidJsonPath(opts.dataEquals.path);
      const path = opts.dataEquals.path;
      conditions.push(
        sql`json_extract(${schedules.targetJson}, ${path}) = ${opts.dataEquals.value}`,
      );
    }
    const baseQuery = this.db.select().from(schedules);
    const whereQuery = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
    // ORDER BY next_fire_at ASC NULLS LAST. SQLite sorts NULLs first
    // by default; the raw `sql` modifier covers the wire contract
    // from the RFC (newest-armed first, never-armed last).
    const rows = whereQuery.orderBy(sql`${schedules.nextFireAt} ASC NULLS LAST`).all();
    return rows.map(rowToEntity);
  }

  /**
   * Cheap preflight read used by `ScheduleService.recover()` to
   * detect rows whose `target_kind` has no registered handler. Only
   * the `(id, targetKind)` projection is selected so a workspace
   * with thousands of disabled schedules doesn't pull every blob's
   * `target_json` into memory just to count kinds.
   */
  async allRowsForPreflight(): Promise<
    readonly { readonly id: string; readonly targetKind: string }[]
  > {
    return this.db
      .select({ id: schedules.id, targetKind: schedules.targetKind })
      .from(schedules)
      .all();
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

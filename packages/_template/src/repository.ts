import { type Logger, silentLogger } from "@emploke/logger";
import { and, eq, like } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import { type __Entity__Row, __entities__ } from "./schema.js";
import { __ENTITY___ID_RE, assertValid__Entity__Id } from "./validate.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed CRUD for the `__entities__` table. Private to the
 * pkg: external callers go through `__Entity__Service` (writes) or
 * `__Entity__Queries` (reads). Defense-in-depth id validation lives
 * here so the table grammar is enforced even if a future caller
 * forgets to validate at the boundary.
 */
export class __Entity__Repository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    // logger is reserved for future row-rejection / migration-skew warnings
    void this.logger;
  }

  async read(id: string): Promise<__Entity__Row | undefined> {
    assertValid__Entity__Id(id);
    return this.db.select().from(__entities__).where(eq(__entities__.id, id)).get();
  }

  async insert(row: __Entity__Row): Promise<void> {
    assertValid__Entity__Id(row.id);
    this.db.insert(__entities__).values(row).run();
  }

  /** Idempotent: silently ignores malformed ids and missing rows. */
  async delete(id: string): Promise<void> {
    if (typeof id !== "string" || !__ENTITY___ID_RE.test(id)) return;
    this.db.delete(__entities__).where(eq(__entities__.id, id)).run();
  }

  async list(opts: { nameStartsWith?: string } = {}): Promise<__Entity__Row[]> {
    const where =
      opts.nameStartsWith !== undefined
        ? like(__entities__.name, `${opts.nameStartsWith}%`)
        : undefined;
    const q = this.db.select().from(__entities__);
    return where !== undefined ? q.where(and(where)).all() : q.all();
  }
}

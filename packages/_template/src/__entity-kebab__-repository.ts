import { and, eq, like } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import type * as schema from "./schema.js";
import { type __Entity__Row, __entities__ } from "./schema.js";
import type { __Entity__ } from "./types.js";
import { __ENTITY___ID_RE, assertValid__Entity__Id } from "./validate.js";

const silentLogger: Logger = pino({ level: "silent" });

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed CRUD for the `__entities__` table. Private to the
 * pkg: external callers go through `__Entity__Service`. Defense-in-
 * depth id validation lives here so the table grammar is enforced
 * even if a future caller forgets to validate at the boundary.
 *
 * **DTO at the boundary:** every public read method returns the
 * pkg-owned {@link __Entity__} DTO, never the Drizzle-inferred
 * {@link __Entity__Row} type. The `*Row` shape exists only as a
 * persistence implementation detail; exposing it would leak the
 * ORM contract upward and re-introduce the kind of `string | null`
 * vs `string` type lies that the dedicated DTO is meant to
 * eliminate. Pattern mirrored from Codex's `ThreadStore` trait
 * (see `docs/pkg-template.md` "Repository contract").
 *
 * If the DTO requires cross-pkg context (e.g. a runtime metadata
 * fetch, a path computed from a layout helper), the repository
 * MAY return an internal `__Entity__Row` for the service to
 * combine with that context — but `*Row` MUST NOT be re-exported
 * from `index.ts`.
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

  async findById(id: string): Promise<__Entity__ | undefined> {
    assertValid__Entity__Id(id);
    const row = this.db.select().from(__entities__).where(eq(__entities__.id, id)).get();
    return row ? rowToDto(row) : undefined;
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

  async list(opts: { nameStartsWith?: string } = {}): Promise<__Entity__[]> {
    const where =
      opts.nameStartsWith !== undefined
        ? like(__entities__.name, `${opts.nameStartsWith}%`)
        : undefined;
    const q = this.db.select().from(__entities__);
    const rows = where !== undefined ? q.where(and(where)).all() : q.all();
    return rows.map(rowToDto);
  }
}

/**
 * Project a persisted row to the public DTO. Module-private — the
 * only legitimate caller is `__Entity__Repository`. Lives here (not
 * in service.ts) so the DTO contract and the row contract are
 * reconciled at the same boundary.
 */
function rowToDto(row: __Entity__Row): __Entity__ {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
  };
}

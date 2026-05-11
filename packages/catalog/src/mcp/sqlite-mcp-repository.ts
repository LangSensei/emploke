import { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { addColumnIfMissing } from "../skill/sqlite-skill-repository.js";
import { Mcp } from "./mcp-entity.js";
import type { McpRepository } from "./mcp-repository.js";

/**
 * SQLite-backed `McpRepository`.
 *
 * Why SQLite over the FS layout:
 *   - true atomicity per row (no .tmp scratch dirs, no sidecar
 *     two-file write hazards, no per-entry path-safety logic)
 *   - cross-process write serialization comes for free (SQLite's
 *     internal locking) — no .lock mkdir-mutex needed
 *   - origin-conflict checks become one-shot SQL (UNIQUE on name +
 *     check existing.origin in a transaction)
 *   - `list` / `scan` are O(rows) via SQL, not O(files) via readdir
 *
 * Schema (single table):
 *   CREATE TABLE mcp (
 *     name      TEXT PRIMARY KEY,
 *     origin    TEXT NOT NULL,
 *     content   TEXT NOT NULL,
 *     orphaned  INTEGER NOT NULL DEFAULT 0
 *   );
 *
 * The `name` column is the catalog FQN (`<namespace>/<short>`); the
 * `origin` column is the install-source URI; `content` is the entity's
 * full bytes (with `_meta` injected by `Mcp.create`); `orphaned` is
 * the per-installation orphan flag. All map 1:1 to the `Mcp` entity.
 *
 * Concurrency: opens with `journal_mode=WAL` so concurrent readers
 * don't block writers and vice versa. WAL also gives crash safety
 * (the WAL file is replayed on next open, so a crash mid-write
 * either commits or rolls back atomically).
 */
export class SqliteMcpRepository implements McpRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  /**
   * Open (and initialise if needed) the SQLite database at `dbPath`.
   * Special path `:memory:` keeps the database in RAM — useful for
   * tests. Pass `dbPath = "/abs/path/to/catalog.db"` for production.
   */
  constructor(dbPath: string, opts?: { logger?: Logger }) {
    this.db = new DatabaseSync(dbPath);
    this.logger = opts?.logger ?? silentLogger;
    // WAL gives concurrent readers + crash safety. NORMAL sync is the
    // standard WAL companion (FULL is overkill for a local catalog).
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp (
        name      TEXT PRIMARY KEY NOT NULL,
        origin    TEXT NOT NULL,
        content   TEXT NOT NULL,
        orphaned  INTEGER NOT NULL DEFAULT 0
      )
    `);
    addColumnIfMissing(this.db, "mcp", "orphaned", "INTEGER NOT NULL DEFAULT 0");
  }

  /** Close the database. Idempotent. */
  close(): void {
    this.db.close();
  }

  async add(mcp: Mcp): Promise<void> {
    // Upsert: catalog semantics treat add as "store this, overwriting
    // any existing entry with the same name". Origin-conflict policy
    // is the service's job (it reads with `findByName` first, decides,
    // then calls `add`); the repo just stores what it's given.
    this.db
      .prepare(
        `INSERT INTO mcp (name, origin, content, orphaned) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           origin = excluded.origin,
           content = excluded.content,
           orphaned = excluded.orphaned`,
      )
      .run(mcp.name, mcp.origin, mcp.content, mcp.orphaned ? 1 : 0);
  }

  async findByName(name: string): Promise<Mcp | null> {
    const row = this.db
      .prepare("SELECT origin, content, orphaned FROM mcp WHERE name = ?")
      .get(name) as { origin: string; content: string; orphaned: number } | undefined;
    if (row === undefined) return null;
    return Mcp.fromStored(name, row.origin, row.content, row.orphaned !== 0);
  }

  async findByOrigin(origin: string): Promise<Mcp | null> {
    const row = this.db
      .prepare("SELECT name, content, orphaned FROM mcp WHERE origin = ? LIMIT 1")
      .get(origin) as { name: string; content: string; orphaned: number } | undefined;
    if (row === undefined) return null;
    return Mcp.fromStored(row.name, origin, row.content, row.orphaned !== 0);
  }

  async delete(name: string): Promise<void> {
    this.db.prepare("DELETE FROM mcp WHERE name = ?").run(name);
  }

  async findAll(): Promise<Mcp[]> {
    const rows = this.db
      .prepare("SELECT name, origin, content, orphaned FROM mcp ORDER BY name")
      .all() as { name: string; origin: string; content: string; orphaned: number }[];
    const out: Mcp[] = [];
    for (const row of rows) {
      try {
        out.push(Mcp.fromStored(row.name, row.origin, row.content, row.orphaned !== 0));
      } catch (cause) {
        // Name failed validation (legacy import, manual edit). Skip
        // and surface a structured warning so operators can spot a
        // corrupted SQLite catalog without trawling every dashboard
        // list — the row stays in the DB (deletion is a separate
        // operation) and is hidden from listings until repaired.
        this.logger.warn("catalog/mcp: skipping row that failed validation", {
          name: row.name ?? null,
          cause: (cause as Error).message,
        });
      }
    }
    return out;
  }

  async setFlags(name: string, flags: { orphaned?: boolean }): Promise<void> {
    if (flags.orphaned === undefined) return;
    this.db.prepare("UPDATE mcp SET orphaned = ? WHERE name = ?").run(flags.orphaned ? 1 : 0, name);
  }

  async setOrphanedBulk(updates: ReadonlyMap<string, boolean>): Promise<void> {
    if (updates.size === 0) return;
    const stmt = this.db.prepare("UPDATE mcp SET orphaned = ? WHERE name = ?");
    this.db.exec("BEGIN");
    try {
      for (const [name, orphaned] of updates) {
        stmt.run(orphaned ? 1 : 0, name);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { Mcp } from "./mcp-entity.js";
import type { McpRepository } from "./mcp-repository.js";

const MCP_PKG_SCHEMA_VERSION = 1;

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
 *     content   TEXT NOT NULL
 *   );
 *
 * The `name` column is the catalog FQN (`<namespace>/<short>`); the
 * `origin` column is the install-source URI; `content` is the entity's
 * full bytes (with `_meta` injected by `Mcp.create`). All map 1:1 to
 * the `Mcp` entity.
 *
 * The constructor takes an already-opened `DatabaseSync`. The server
 * shares one connection across every per-workspace repository
 * (task / session / catalog / workflow), so the file handle count per
 * workspace stays at one. PRAGMAs (journal_mode, synchronous,
 * foreign_keys, ...) are the caller's responsibility — the workspace
 * pkg sets them once on the shared connection.
 *
 * Schema versioning is per-pkg: this repo writes its own row to
 * `schema_meta` keyed by `pkg='catalog_mcp'`, sibling to the rows
 * written by `SqliteSkillRepository` (`catalog_skill`) and
 * `SqliteAgentRepository` (`catalog_agent`).
 */
export class SqliteMcpRepository implements McpRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  constructor(opts: { db: DatabaseSync; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    this.ensureSchema();
  }

  /** No-op — the connection is owned by the caller. */
  close(): void {
    // intentionally empty
  }

  async add(mcp: Mcp): Promise<void> {
    // Upsert: catalog semantics treat add as "store this, overwriting
    // any existing entry with the same name". Origin-conflict policy
    // is the service's job (it reads with `findByName` first, decides,
    // then calls `add`); the repo just stores what it's given.
    this.db
      .prepare(
        `INSERT INTO mcp (name, origin, content) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           origin = excluded.origin,
           content = excluded.content`,
      )
      .run(mcp.name, mcp.origin, mcp.content);
  }

  async findByName(name: string): Promise<Mcp | null> {
    const row = this.db.prepare("SELECT origin, content FROM mcp WHERE name = ?").get(name) as
      | { origin: string; content: string }
      | undefined;
    if (row === undefined) return null;
    return Mcp.fromStored(name, row.origin, row.content);
  }

  async findByOrigin(origin: string): Promise<Mcp | null> {
    const row = this.db
      .prepare("SELECT name, content FROM mcp WHERE origin = ? LIMIT 1")
      .get(origin) as { name: string; content: string } | undefined;
    if (row === undefined) return null;
    return Mcp.fromStored(row.name, origin, row.content);
  }

  async delete(name: string): Promise<void> {
    this.db.prepare("DELETE FROM mcp WHERE name = ?").run(name);
  }

  async findAll(): Promise<Mcp[]> {
    const rows = this.db.prepare("SELECT name, origin, content FROM mcp ORDER BY name").all() as {
      name: string;
      origin: string;
      content: string;
    }[];
    const out: Mcp[] = [];
    for (const row of rows) {
      try {
        out.push(Mcp.fromStored(row.name, row.origin, row.content));
      } catch (cause) {
        // Name failed validation (legacy import, manual edit). Skip
        // and surface a structured warning so operators can spot a
        // corrupted SQLite catalog without trawling every dashboard
        // list — the row stays in the DB (deletion is a separate
        // operation) and is hidden from listings until repaired.
        this.logger.warn(
          {
            name: row.name ?? null,
            cause: (cause as Error).message,
          },
          "catalog/mcp: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  // ─── schema management ──────────────────────────────────────

  private ensureSchema(): void {
    // Post-issue-#123: the MigrationCoordinator owns DDL. This
    // repository's job is to assert the post-condition — a
    // `schema_meta` row for the `catalog_mcp` pkg at the expected
    // version. A missing row means `runPkgMigrations` was not run
    // before construction (always a wiring bug).
    //
    // Both branches surface as the framework's typed errors
    // (`SchemaMetaNotBootstrappedError` / `SchemaMetaMismatchError`)
    // so consumers can route uniformly across every per-pkg repo.
    let existing: { version: number } | undefined;
    try {
      existing = this.db
        .prepare("SELECT version FROM schema_meta WHERE pkg = ?")
        .get("catalog_mcp") as { version: number } | undefined;
    } catch {
      // `schema_meta` itself missing → coordinator never ran.
      throw new SchemaMetaNotBootstrappedError("catalog_mcp");
    }
    if (existing === undefined) {
      throw new SchemaMetaNotBootstrappedError("catalog_mcp");
    }
    if (existing.version !== MCP_PKG_SCHEMA_VERSION) {
      throw new SchemaMetaMismatchError("catalog_mcp", existing.version, MCP_PKG_SCHEMA_VERSION);
    }
  }
}

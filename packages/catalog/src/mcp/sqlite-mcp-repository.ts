import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { Mcp } from "./mcp-entity.js";
import type { McpRepository } from "./mcp-repository.js";

const MCP_PKG_SCHEMA_VERSION = 2;

/**
 * SQLite-backed `McpRepository` (catalog v2 — issue #122).
 *
 * Table is now plural `mcps` with `fqn` / `spec` columns plus the
 * `json_valid(spec)` CHECK, and timestamps. The MCP spec's
 * `_meta.name` JSON key stays as-is on the wire.
 */
export class SqliteMcpRepository implements McpRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  constructor(opts: { db: DatabaseSync; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    this.ensureSchema();
  }

  close(): void {
    // intentionally empty
  }

  async add(mcp: Mcp): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mcps (fqn, origin, spec, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fqn) DO UPDATE SET
           origin = excluded.origin,
           spec = excluded.spec,
           updated_at = excluded.updated_at`,
      )
      .run(mcp.fqn, mcp.origin, mcp.spec, now, now);
  }

  async findByFqn(fqn: string): Promise<Mcp | null> {
    const row = this.db
      .prepare("SELECT origin, spec, installed_at, updated_at FROM mcps WHERE fqn = ?")
      .get(fqn) as
      | { origin: string; spec: string; installed_at: string; updated_at: string }
      | undefined;
    if (row === undefined) return null;
    return Mcp.fromStored(fqn, row.origin, row.spec, row.installed_at, row.updated_at);
  }

  async findByOrigin(origin: string): Promise<Mcp | null> {
    const row = this.db
      .prepare("SELECT fqn, spec, installed_at, updated_at FROM mcps WHERE origin = ? LIMIT 1")
      .get(origin) as
      | { fqn: string; spec: string; installed_at: string; updated_at: string }
      | undefined;
    if (row === undefined) return null;
    return Mcp.fromStored(row.fqn, origin, row.spec, row.installed_at, row.updated_at);
  }

  async delete(fqn: string): Promise<void> {
    this.db.prepare("DELETE FROM mcps WHERE fqn = ?").run(fqn);
  }

  async findAll(): Promise<Mcp[]> {
    const rows = this.db
      .prepare("SELECT fqn, origin, spec, installed_at, updated_at FROM mcps ORDER BY fqn")
      .all() as {
      fqn: string;
      origin: string;
      spec: string;
      installed_at: string;
      updated_at: string;
    }[];
    const out: Mcp[] = [];
    for (const row of rows) {
      try {
        out.push(Mcp.fromStored(row.fqn, row.origin, row.spec, row.installed_at, row.updated_at));
      } catch (cause) {
        this.logger.warn(
          { fqn: row.fqn ?? null, cause: (cause as Error).message },
          "catalog/mcp: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  async findDependentAgents(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT source_fqn FROM agent_mcp_dependencies WHERE target_fqn = ? ORDER BY source_fqn",
      )
      .all(targetFqn) as unknown as { source_fqn: string }[];
    return rows.map((r) => r.source_fqn);
  }

  async findDependentSkills(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT source_fqn FROM skill_mcp_dependencies WHERE target_fqn = ? ORDER BY source_fqn",
      )
      .all(targetFqn) as unknown as { source_fqn: string }[];
    return rows.map((r) => r.source_fqn);
  }

  private ensureSchema(): void {
    let existing: { version: number } | undefined;
    try {
      existing = this.db
        .prepare("SELECT version FROM schema_meta WHERE pkg = ?")
        .get("catalog_mcp") as { version: number } | undefined;
    } catch {
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

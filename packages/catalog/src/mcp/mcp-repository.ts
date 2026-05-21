import pino, { type Logger } from "pino";

const silentLogger: Logger = pino({ level: "silent" });

import { count, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../schema.js";
import { agentMcpDeps, mcps, skillMcpDeps } from "../schema.js";
import { McpEntity } from "./mcp-entity.js";

type Db = BetterSQLite3Database<typeof schema>;

export class McpRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty
  }

  async add(mcp: McpEntity): Promise<void> {
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      const existing = tx.select({ fqn: mcps.fqn }).from(mcps).where(eq(mcps.fqn, mcp.fqn)).get();
      if (existing !== undefined) {
        tx.update(mcps)
          .set({ origin: mcp.origin, spec: mcp.spec, updatedAt: now })
          .where(eq(mcps.fqn, mcp.fqn))
          .run();
      } else {
        tx.insert(mcps)
          .values({
            fqn: mcp.fqn,
            origin: mcp.origin,
            spec: mcp.spec,
            installedAt: now,
            updatedAt: now,
          })
          .run();
      }
    });
  }

  async findByFqn(fqn: string): Promise<McpEntity | null> {
    const row = this.db.select().from(mcps).where(eq(mcps.fqn, fqn)).get();
    if (row === undefined) return null;
    return McpEntity.fromStored(row.fqn, row.origin, row.spec, row.installedAt, row.updatedAt);
  }

  async findByOrigin(origin: string): Promise<McpEntity | null> {
    const row = this.db.select().from(mcps).where(eq(mcps.origin, origin)).get();
    if (row === undefined) return null;
    return McpEntity.fromStored(row.fqn, row.origin, row.spec, row.installedAt, row.updatedAt);
  }

  async delete(fqn: string): Promise<void> {
    const skillDepCount =
      this.db.select({ c: count() }).from(skillMcpDeps).where(eq(skillMcpDeps.targetFqn, fqn)).get()
        ?.c ?? 0;
    const agentDepCount =
      this.db.select({ c: count() }).from(agentMcpDeps).where(eq(agentMcpDeps.targetFqn, fqn)).get()
        ?.c ?? 0;
    if (skillDepCount + agentDepCount > 0) {
      const e = new Error(
        `FOREIGN KEY constraint failed: ${skillDepCount + agentDepCount} dependent(s) reference ${fqn}`,
      );
      (e as Error & { code: string }).code = "SQLITE_CONSTRAINT_FOREIGNKEY";
      throw e;
    }
    this.db.delete(mcps).where(eq(mcps.fqn, fqn)).run();
  }

  async findAll(): Promise<McpEntity[]> {
    const rows = this.db.select().from(mcps).orderBy(mcps.fqn).all();
    const out: McpEntity[] = [];
    for (const row of rows) {
      try {
        out.push(
          McpEntity.fromStored(row.fqn, row.origin, row.spec, row.installedAt, row.updatedAt),
        );
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
      .select()
      .from(agentMcpDeps)
      .where(eq(agentMcpDeps.targetFqn, targetFqn))
      .orderBy(agentMcpDeps.sourceFqn)
      .all();
    return rows.map((r) => r.sourceFqn);
  }

  async findDependentSkills(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .select()
      .from(skillMcpDeps)
      .where(eq(skillMcpDeps.targetFqn, targetFqn))
      .orderBy(skillMcpDeps.sourceFqn)
      .all();
    return rows.map((r) => r.sourceFqn);
  }
}

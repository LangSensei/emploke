import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { HasDependentsError } from "../_shared/dependents-error.js";
import type * as schema from "../schema.js";
import { agentMcpDeps, mcps, skillMcpDeps } from "../schema.js";
import { McpEntity } from "./mcp-entity.js";

const silentLogger: Logger = pino({ level: "silent" });

type Db = BetterSQLite3Database<typeof schema>;

export class McpRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty — `compose.ts` owns the sqlite handle lifecycle
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
    // Race-free: collect dependents + delete in one transaction so a
    // concurrent `installSkill` / `installAgent` that adds a new dep
    // on this mcp can't slip between our check and the row removal.
    // Stands in for missing FK constraints in these tables — same
    // pattern as `SkillRepository.delete` / `AgentRepository.delete`.
    // Throwing inside the transaction callback rolls back the empty
    // delete and propagates `HasDependentsError` to the caller.
    this.db.transaction((tx) => {
      const skillDeps = tx
        .select({ sourceFqn: skillMcpDeps.sourceFqn })
        .from(skillMcpDeps)
        .where(eq(skillMcpDeps.targetFqn, fqn))
        .orderBy(skillMcpDeps.sourceFqn)
        .all();
      const agentDeps = tx
        .select({ sourceFqn: agentMcpDeps.sourceFqn })
        .from(agentMcpDeps)
        .where(eq(agentMcpDeps.targetFqn, fqn))
        .orderBy(agentMcpDeps.sourceFqn)
        .all();
      if (skillDeps.length + agentDeps.length > 0) {
        throw new HasDependentsError(fqn, [
          ...skillDeps.map((r) => ({ kind: "skill" as const, name: r.sourceFqn })),
          ...agentDeps.map((r) => ({ kind: "agent" as const, name: r.sourceFqn })),
        ]);
      }
      tx.delete(mcps).where(eq(mcps.fqn, fqn)).run();
    });
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
          { fqn: row.fqn ?? null, err: cause },
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

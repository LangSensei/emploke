import type { EntityManager } from "@mikro-orm/core";
import { type Logger, silentLogger } from "@emploke/logger";
import { AgentMcpDepRow, McpRow, SkillMcpDepRow } from "../entity.js";
import { Mcp } from "./mcp-entity.js";
import type { McpRepository } from "./mcp-repository.js";

export class MikroMcpRepository implements McpRepository {
  private readonly em: EntityManager;
  private readonly logger: Logger;

  constructor(opts: { em: EntityManager; logger?: Logger }) {
    this.em = opts.em;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty
  }

  async add(mcp: Mcp): Promise<void> {
    const now = new Date().toISOString();
    await this.em.transactional(async (em) => {
      em.clear();
      const existing = await em.findOne(McpRow, { fqn: mcp.fqn });
      if (existing !== null) {
        Object.assign(existing, {
          origin: mcp.origin,
          spec: mcp.spec,
          updatedAt: now,
        });
        em.persist(existing);
      } else {
        em.persist(
          em.create(McpRow, {
            fqn: mcp.fqn,
            origin: mcp.origin,
            spec: mcp.spec,
            installedAt: now,
            updatedAt: now,
          }),
        );
      }
    });
  }

  async findByFqn(fqn: string): Promise<Mcp | null> {
    const row = await this.em.fork().findOne(McpRow, { fqn });
    if (row === null) return null;
    return Mcp.fromStored(row.fqn, row.origin, row.spec, row.installedAt, row.updatedAt);
  }

  async findByOrigin(origin: string): Promise<Mcp | null> {
    const row = await this.em.fork().findOne(McpRow, { origin });
    if (row === null) return null;
    return Mcp.fromStored(row.fqn, row.origin, row.spec, row.installedAt, row.updatedAt);
  }

  async delete(fqn: string): Promise<void> {
    // Replicate the old FK ON DELETE RESTRICT behaviour: refuse if any
    // skill or agent still references this MCP. The facade catches
    // this and rethrows as HasDependentsError.
    const em = this.em.fork();
    const skillDeps = await em.count(SkillMcpDepRow, { targetFqn: fqn });
    const agentDeps = await em.count(AgentMcpDepRow, { targetFqn: fqn });
    if (skillDeps + agentDeps > 0) {
      const e = new Error(
        `FOREIGN KEY constraint failed: ${skillDeps + agentDeps} dependent(s) reference ${fqn}`,
      );
      (e as Error & { code: string }).code = "SQLITE_CONSTRAINT_FOREIGNKEY";
      throw e;
    }
    await this.em.fork().nativeDelete(McpRow, { fqn });
  }

  async findAll(): Promise<Mcp[]> {
    const rows = await this.em.fork().find(McpRow, {}, { orderBy: { fqn: "asc" } });
    const out: Mcp[] = [];
    for (const row of rows) {
      try {
        out.push(Mcp.fromStored(row.fqn, row.origin, row.spec, row.installedAt, row.updatedAt));
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
    const rows = await this.em
      .fork()
      .find(AgentMcpDepRow, { targetFqn }, { orderBy: { sourceFqn: "asc" } });
    return rows.map((r) => r.sourceFqn);
  }

  async findDependentSkills(targetFqn: string): Promise<string[]> {
    const rows = await this.em
      .fork()
      .find(SkillMcpDepRow, { targetFqn }, { orderBy: { sourceFqn: "asc" } });
    return rows.map((r) => r.sourceFqn);
  }
}

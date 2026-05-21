import type { EntityManager } from "@mikro-orm/core";
import { type Logger, silentLogger } from "@emploke/logger";
import {
  AgentFileRow,
  AgentMcpDepRow,
  AgentRow,
  AgentSkillDepRow,
} from "../entity.js";
import { Agent, type AgentDependencies } from "./agent-entity.js";
import type { AgentFile, AgentRepoAddDeps, AgentRepository } from "./agent-repository.js";
import { AgentNotFoundError } from "./errors.js";

/**
 * MikroORM-backed `AgentRepository`.
 *
 * Maps `Agent` ↔ {`AgentRow`, `AgentFileRow`, `AgentSkillDepRow`,
 * `AgentMcpDepRow`} at the boundary. Add operations run inside
 * `em.transactional(...)` so the entity-row + files + dep-table writes
 * commit atomically.
 */
export class MikroAgentRepository implements AgentRepository {
  private readonly em: EntityManager;
  private readonly logger: Logger;

  constructor(opts: { em: EntityManager; logger?: Logger }) {
    this.em = opts.em;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty
  }

  async add(
    agent: Agent,
    files: ReadonlyMap<string, Buffer>,
    deps: AgentRepoAddDeps,
  ): Promise<void> {
    if (!files.has("AGENTS.md")) {
      throw new TypeError(
        `AgentRepository.add requires AGENTS.md in the files map (got: ${[...files.keys()].join(", ")})`,
      );
    }
    const now = new Date().toISOString();
    await this.em.transactional(async (em) => {
      em.clear();
      const existing = await em.findOne(AgentRow, { fqn: agent.fqn });
      if (existing !== null) {
        Object.assign(existing, {
          origin: agent.origin,
          description: agent.description,
          version: agent.version,
          prereqs: agent.prereqs ?? null,
          prereqsAck: agent.prereqsAck ? 1 : 0,
          disabledByUser: agent.disabledByUser ? 1 : 0,
          updatedAt: now,
        });
        em.persist(existing);
      } else {
        const row = em.create(AgentRow, {
          fqn: agent.fqn,
          origin: agent.origin,
          description: agent.description,
          version: agent.version,
          prereqs: agent.prereqs ?? null,
          prereqsAck: agent.prereqsAck ? 1 : 0,
          disabledByUser: agent.disabledByUser ? 1 : 0,
          installedAt: now,
          updatedAt: now,
        });
        em.persist(row);
      }
      await em.nativeDelete(AgentFileRow, { agentFqn: agent.fqn });
      for (const [relPath, content] of files) {
        const af = new AgentFileRow(); af.agentFqn = agent.fqn; af.relPath = relPath; af.content = content; em.persist(af);
      }
      await em.nativeDelete(AgentSkillDepRow, { sourceFqn: agent.fqn });
      await em.nativeDelete(AgentMcpDepRow, { sourceFqn: agent.fqn });
      const seenSkill = new Set<string>();
      for (const targetFqn of deps.skills) {
        if (seenSkill.has(targetFqn)) continue;
        seenSkill.add(targetFqn);
        const asd = new AgentSkillDepRow(); asd.sourceFqn = agent.fqn; asd.targetFqn = targetFqn; em.persist(asd);
      }
      const seenMcp = new Set<string>();
      for (const targetFqn of deps.mcps) {
        if (seenMcp.has(targetFqn)) continue;
        seenMcp.add(targetFqn);
        const amd = new AgentMcpDepRow(); amd.sourceFqn = agent.fqn; amd.targetFqn = targetFqn; em.persist(amd);
      }
    });
  }

  async findByFqn(fqn: string): Promise<Agent | null> {
    const row = await this.em.fork().findOne(AgentRow, { fqn });
    if (row === null) return null;
    const deps = await this.listDependencies(fqn);
    return rowToAgent(row, deps);
  }

  async findByOrigin(origin: string): Promise<Agent | null> {
    const row = await this.em.fork().findOne(AgentRow, { origin });
    if (row === null) return null;
    const deps = await this.listDependencies(row.fqn);
    return rowToAgent(row, deps);
  }

  async findAll(): Promise<Agent[]> {
    const em = this.em.fork();
    const rows = await em.find(AgentRow, {}, { orderBy: { fqn: "asc" } });
    const depsByFqn = await this.loadAllDeps(em);
    const out: Agent[] = [];
    for (const row of rows) {
      try {
        const deps = depsByFqn.get(row.fqn) ?? { skills: [], mcps: [] };
        out.push(rowToAgent(row, deps));
      } catch (cause) {
        this.logger.warn(
          { fqn: row.fqn ?? null, cause: (cause as Error).message },
          "catalog/agent: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  async delete(fqn: string): Promise<void> {
    await this.em.transactional(async (em) => {
      await em.nativeDelete(AgentFileRow, { agentFqn: fqn });
      await em.nativeDelete(AgentSkillDepRow, { sourceFqn: fqn });
      await em.nativeDelete(AgentMcpDepRow, { sourceFqn: fqn });
      await em.nativeDelete(AgentRow, { fqn });
    });
  }

  async *streamFiles(fqn: string): AsyncIterable<AgentFile> {
    const rows = await this.em.fork().find(AgentFileRow, { agentFqn: fqn });
    for (const row of rows) {
      yield {
        relPath: row.relPath,
        content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
      };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = await this.em.fork().findOne(AgentFileRow, { agentFqn: fqn, relPath: "AGENTS.md" });
    if (row === null) throw new AgentNotFoundError(fqn);
    const buf = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    return buf.toString("utf8");
  }

  async listDependencies(fqn: string): Promise<AgentDependencies> {
    const em = this.em.fork();
    const skillRows = await em.find(
      AgentSkillDepRow,
      { sourceFqn: fqn },
      { orderBy: { targetFqn: "asc" } },
    );
    const mcpRows = await em.find(
      AgentMcpDepRow,
      { sourceFqn: fqn },
      { orderBy: { targetFqn: "asc" } },
    );
    return {
      skills: skillRows.map((r) => ({ fqn: r.targetFqn })),
      mcps: mcpRows.map((r) => ({ fqn: r.targetFqn })),
    };
  }

  async setFlags(
    fqn: string,
    flags: { prereqsAck?: boolean; disabledByUser?: boolean },
  ): Promise<void> {
    const patch: { prereqsAck?: number; disabledByUser?: number; updatedAt?: string } = {};
    if (flags.prereqsAck !== undefined) patch.prereqsAck = flags.prereqsAck ? 1 : 0;
    if (flags.disabledByUser !== undefined) patch.disabledByUser = flags.disabledByUser ? 1 : 0;
    if (Object.keys(patch).length === 0) return;
    patch.updatedAt = new Date().toISOString();
    await this.em.fork().nativeUpdate(AgentRow, { fqn }, patch);
  }

  private async loadAllDeps(em: EntityManager): Promise<Map<string, AgentDependencies>> {
    const out = new Map<string, AgentDependencies>();
    const skillRows = await em.find(
      AgentSkillDepRow,
      {},
      { orderBy: { sourceFqn: "asc", targetFqn: "asc" } },
    );
    const mcpRows = await em.find(
      AgentMcpDepRow,
      {},
      { orderBy: { sourceFqn: "asc", targetFqn: "asc" } },
    );
    for (const r of skillRows) {
      const e = out.get(r.sourceFqn) ?? { skills: [], mcps: [] };
      out.set(r.sourceFqn, {
        skills: [...e.skills, { fqn: r.targetFqn }],
        mcps: e.mcps,
      });
    }
    for (const r of mcpRows) {
      const e = out.get(r.sourceFqn) ?? { skills: [], mcps: [] };
      out.set(r.sourceFqn, {
        skills: e.skills,
        mcps: [...e.mcps, { fqn: r.targetFqn }],
      });
    }
    return out;
  }
}

function rowToAgent(row: AgentRow, deps: AgentDependencies): Agent {
  return Agent.fromStored({
    fqn: row.fqn,
    origin: row.origin,
    description: row.description,
    version: row.version,
    prereqs: row.prereqs ?? undefined,
    dependencies: deps,
    prereqsAck: row.prereqsAck !== 0,
    disabledByUser: row.disabledByUser !== 0,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
  });
}

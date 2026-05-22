import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import type * as schema from "../schema.js";
import { agentFiles, agentMcpDeps, agentSkillDeps, agents } from "../schema.js";
import { type AgentDependencies, AgentEntity } from "./agent-entity.js";
import { AgentNotFoundError } from "./errors.js";

const silentLogger: Logger = pino({ level: "silent" });
/** One file inside an agent, as yielded by {@link AgentRepository.streamFiles}. */
export interface AgentFile {
  readonly relPath: string;
  readonly content: Buffer;
}

/** Resolved fqn-form dependencies passed to {@link AgentRepository.add}. */
export interface AgentRepoAddDeps {
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
}

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed `AgentRepository`. Multi-table writes are wrapped in
 * `db.transaction(...)` so the row + files + dep rows commit atomically.
 */
export class AgentRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty
  }

  async add(
    agent: AgentEntity,
    files: ReadonlyMap<string, Buffer>,
    deps: AgentRepoAddDeps,
  ): Promise<void> {
    if (!files.has("AGENTS.md")) {
      throw new TypeError(
        `AgentRepository.add requires AGENTS.md in the files map (got: ${[...files.keys()].join(", ")})`,
      );
    }
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      const existing = tx
        .select({ fqn: agents.fqn })
        .from(agents)
        .where(eq(agents.fqn, agent.fqn))
        .get();
      const baseFields = {
        origin: agent.origin,
        description: agent.description,
        version: agent.version,
        prereqs: agent.prereqs ?? null,
        prereqsAck: agent.prereqsAck ? 1 : 0,
        disabledByUser: agent.disabledByUser ? 1 : 0,
        updatedAt: now,
      };
      if (existing !== undefined) {
        tx.update(agents).set(baseFields).where(eq(agents.fqn, agent.fqn)).run();
      } else {
        tx.insert(agents)
          .values({ fqn: agent.fqn, installedAt: now, ...baseFields })
          .run();
      }
      tx.delete(agentFiles).where(eq(agentFiles.agentFqn, agent.fqn)).run();
      for (const [relPath, content] of files) {
        tx.insert(agentFiles).values({ agentFqn: agent.fqn, relPath, content }).run();
      }
      tx.delete(agentSkillDeps).where(eq(agentSkillDeps.sourceFqn, agent.fqn)).run();
      tx.delete(agentMcpDeps).where(eq(agentMcpDeps.sourceFqn, agent.fqn)).run();
      const seenSkill = new Set<string>();
      for (const targetFqn of deps.skills) {
        if (seenSkill.has(targetFqn)) continue;
        seenSkill.add(targetFqn);
        tx.insert(agentSkillDeps).values({ sourceFqn: agent.fqn, targetFqn }).run();
      }
      const seenMcp = new Set<string>();
      for (const targetFqn of deps.mcps) {
        if (seenMcp.has(targetFqn)) continue;
        seenMcp.add(targetFqn);
        tx.insert(agentMcpDeps).values({ sourceFqn: agent.fqn, targetFqn }).run();
      }
    });
  }

  async findByFqn(fqn: string): Promise<AgentEntity | null> {
    const row = this.db.select().from(agents).where(eq(agents.fqn, fqn)).get();
    if (row === undefined) return null;
    const deps = await this.listDependencies(fqn);
    return rowToAgent(row, deps);
  }

  async findByOrigin(origin: string): Promise<AgentEntity | null> {
    const row = this.db.select().from(agents).where(eq(agents.origin, origin)).get();
    if (row === undefined) return null;
    const deps = await this.listDependencies(row.fqn);
    return rowToAgent(row, deps);
  }

  async findAll(): Promise<AgentEntity[]> {
    const rows = this.db.select().from(agents).orderBy(agents.fqn).all();
    const depsByFqn = this.loadAllDeps();
    const out: AgentEntity[] = [];
    for (const row of rows) {
      try {
        const deps = depsByFqn.get(row.fqn) ?? { skills: [], mcps: [] };
        out.push(rowToAgent(row, deps));
      } catch (cause) {
        this.logger.warn(
          { fqn: row.fqn ?? null, err: cause },
          "catalog/agent: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  async delete(fqn: string): Promise<void> {
    // No dep-count check: nothing in the catalog model depends on an
    // agent (agents are top-of-graph). Compare with
    // `SkillRepository.delete` / `McpRepository.delete` which guard
    // against dependent skills / mcps via in-repo `count()` checks
    // (FK substitute for the constraints we dropped). For agents
    // there's no FK-substitute guard to apply.
    this.db.transaction((tx) => {
      tx.delete(agentFiles).where(eq(agentFiles.agentFqn, fqn)).run();
      tx.delete(agentSkillDeps).where(eq(agentSkillDeps.sourceFqn, fqn)).run();
      tx.delete(agentMcpDeps).where(eq(agentMcpDeps.sourceFqn, fqn)).run();
      tx.delete(agents).where(eq(agents.fqn, fqn)).run();
    });
  }

  async *streamFiles(fqn: string): AsyncIterable<AgentFile> {
    const rows = this.db.select().from(agentFiles).where(eq(agentFiles.agentFqn, fqn)).all();
    for (const row of rows) {
      yield {
        relPath: row.relPath,
        content: Buffer.isBuffer(row.content)
          ? row.content
          : Buffer.from(row.content as Uint8Array),
      };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = this.db
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.agentFqn, fqn), eq(agentFiles.relPath, "AGENTS.md")))
      .get();
    if (row === undefined) throw new AgentNotFoundError(fqn);
    const buf = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content as Uint8Array);
    return buf.toString("utf8");
  }

  async listDependencies(fqn: string): Promise<AgentDependencies> {
    const skillRows = this.db
      .select()
      .from(agentSkillDeps)
      .where(eq(agentSkillDeps.sourceFqn, fqn))
      .orderBy(agentSkillDeps.targetFqn)
      .all();
    const mcpRows = this.db
      .select()
      .from(agentMcpDeps)
      .where(eq(agentMcpDeps.sourceFqn, fqn))
      .orderBy(agentMcpDeps.targetFqn)
      .all();
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
    this.db.update(agents).set(patch).where(eq(agents.fqn, fqn)).run();
  }

  private loadAllDeps(): Map<string, AgentDependencies> {
    const out = new Map<string, AgentDependencies>();
    const skillRows = this.db
      .select()
      .from(agentSkillDeps)
      .orderBy(agentSkillDeps.sourceFqn, agentSkillDeps.targetFqn)
      .all();
    const mcpRows = this.db
      .select()
      .from(agentMcpDeps)
      .orderBy(agentMcpDeps.sourceFqn, agentMcpDeps.targetFqn)
      .all();
    for (const r of skillRows) {
      const e = out.get(r.sourceFqn) ?? { skills: [], mcps: [] };
      out.set(r.sourceFqn, { skills: [...e.skills, { fqn: r.targetFqn }], mcps: e.mcps });
    }
    for (const r of mcpRows) {
      const e = out.get(r.sourceFqn) ?? { skills: [], mcps: [] };
      out.set(r.sourceFqn, { skills: e.skills, mcps: [...e.mcps, { fqn: r.targetFqn }] });
    }
    return out;
  }
}

function rowToAgent(row: typeof agents.$inferSelect, deps: AgentDependencies): AgentEntity {
  return AgentEntity.fromStored({
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

import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { nowIso } from "../_shared/entity-helpers.js";
import {
  aggregateDepsForFqn,
  coerceToBuffer,
  dedupedDepEdges,
  emptyFqnDeps,
  groupDepRowsBySource,
} from "../_shared/repo-helpers.js";
import type * as schema from "../schema.js";
import { agentFiles, agentMcpDeps, agentSkillDeps, agents } from "../schema.js";
import { AGENT_DEP_SPECS_EXPORT, type AgentDependencies, AgentEntity } from "./agent-entity.js";
import type { AgentDepKind } from "./agent-frontmatter.js";
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
 *
 * Composition: this class wires the agent-specific drizzle tables; the
 * cross-kind plumbing (dep dedupe, blob coercion, dep-rows aggregation)
 * comes from `_shared/repo-helpers.ts`. No inheritance.
 */
export class AgentRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty — `compose.ts` owns the sqlite handle lifecycle
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
    const now = nowIso();
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
      for (const edge of dedupedDepEdges(AGENT_DEP_SPECS_EXPORT, deps, agent.fqn)) {
        if (edge.kind === "skills") {
          tx.insert(agentSkillDeps)
            .values({ sourceFqn: agent.fqn, targetFqn: edge.targetFqn })
            .run();
        } else {
          tx.insert(agentMcpDeps).values({ sourceFqn: agent.fqn, targetFqn: edge.targetFqn }).run();
        }
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
        const deps = depsByFqn.get(row.fqn) ?? emptyFqnDeps(AGENT_DEP_SPECS_EXPORT);
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
      yield { relPath: row.relPath, content: coerceToBuffer(row.content) };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = this.db
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.agentFqn, fqn), eq(agentFiles.relPath, "AGENTS.md")))
      .get();
    if (row === undefined) throw new AgentNotFoundError(fqn);
    return coerceToBuffer(row.content).toString("utf8");
  }

  async listDependencies(fqn: string): Promise<AgentDependencies> {
    const skillRows = this.db
      .select({ targetFqn: agentSkillDeps.targetFqn })
      .from(agentSkillDeps)
      .where(eq(agentSkillDeps.sourceFqn, fqn))
      .orderBy(agentSkillDeps.targetFqn)
      .all();
    const mcpRows = this.db
      .select({ targetFqn: agentMcpDeps.targetFqn })
      .from(agentMcpDeps)
      .where(eq(agentMcpDeps.sourceFqn, fqn))
      .orderBy(agentMcpDeps.targetFqn)
      .all();
    return aggregateDepsForFqn<AgentDepKind>(AGENT_DEP_SPECS_EXPORT, {
      skills: skillRows,
      mcps: mcpRows,
    });
  }

  async setFlags(
    fqn: string,
    flags: { prereqsAck?: boolean; disabledByUser?: boolean },
  ): Promise<void> {
    const patch: { prereqsAck?: number; disabledByUser?: number; updatedAt?: string } = {};
    if (flags.prereqsAck !== undefined) patch.prereqsAck = flags.prereqsAck ? 1 : 0;
    if (flags.disabledByUser !== undefined) patch.disabledByUser = flags.disabledByUser ? 1 : 0;
    if (Object.keys(patch).length === 0) return;
    patch.updatedAt = nowIso();
    this.db.update(agents).set(patch).where(eq(agents.fqn, fqn)).run();
  }

  private loadAllDeps(): Map<string, AgentDependencies> {
    const skillRows = this.db
      .select({
        sourceFqn: agentSkillDeps.sourceFqn,
        targetFqn: agentSkillDeps.targetFqn,
      })
      .from(agentSkillDeps)
      .orderBy(agentSkillDeps.sourceFqn, agentSkillDeps.targetFqn)
      .all();
    const mcpRows = this.db
      .select({
        sourceFqn: agentMcpDeps.sourceFqn,
        targetFqn: agentMcpDeps.targetFqn,
      })
      .from(agentMcpDeps)
      .orderBy(agentMcpDeps.sourceFqn, agentMcpDeps.targetFqn)
      .all();
    return groupDepRowsBySource<AgentDepKind>(AGENT_DEP_SPECS_EXPORT, {
      skills: skillRows,
      mcps: mcpRows,
    });
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

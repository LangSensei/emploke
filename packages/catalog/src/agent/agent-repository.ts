import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { emptyDeps } from "../_shared/dep-keys.js";
import { HasDependentsError } from "../_shared/dependents-error.js";
import type * as schema from "../schema.js";
import { agentAgentDeps, agentFiles, agentMcpDeps, agentSkillDeps, agents } from "../schema.js";
import { type AgentDependencies, AgentEntity } from "./agent-entity.js";
import { AGENT_DEP_SPECS } from "./agent-frontmatter.js";
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
  readonly agents: readonly string[];
}

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Drizzle-backed `AgentRepository`. Multi-table writes are wrapped in
 * `db.transaction(...)` so the row + files + dep rows commit atomically.
 *
 * Owned entirely by `agent/` per the decoupling-over-abstraction axiom.
 * Dep dedupe, blob coercion, and dep-rows aggregation are inlined per
 * kind (see {@link toBuf}, the `add`'s skipSelf-dedupe loop, and
 * {@link loadAllDeps}) — no shared helper module. Skill mirrors the
 * same shape by intent.
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
      tx.delete(agentAgentDeps).where(eq(agentAgentDeps.sourceFqn, agent.fqn)).run();
      // Per-kind dedupe + skipSelf-apply, fanned out to the typed
      // dep tables. The `skipSelf` branch is dead for agent today
      // (no AGENT_DEP_SPEC sets `skipSelf`), but kept so agents
      // gaining a self-edge-bearing dep-kind in the future can opt
      // in by flipping spec.skipSelf — no surgery here.
      for (const spec of AGENT_DEP_SPECS) {
        const list =
          (spec.kind === "skills" ? deps.skills : spec.kind === "mcps" ? deps.mcps : deps.agents) ??
          [];
        const seen = new Set<string>();
        for (const targetFqn of list) {
          if (spec.skipSelf === true && targetFqn === agent.fqn) continue;
          if (seen.has(targetFqn)) continue;
          seen.add(targetFqn);
          if (spec.kind === "skills") {
            tx.insert(agentSkillDeps).values({ sourceFqn: agent.fqn, targetFqn }).run();
          } else if (spec.kind === "mcps") {
            tx.insert(agentMcpDeps).values({ sourceFqn: agent.fqn, targetFqn }).run();
          } else {
            tx.insert(agentAgentDeps).values({ sourceFqn: agent.fqn, targetFqn }).run();
          }
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
        const deps = depsByFqn.get(row.fqn) ?? emptyDeps(AGENT_DEP_SPECS);
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
    // Race-free: collect agent dependents + delete in one transaction
    // so a concurrent `installAgent` that adds an agent→agent edge on
    // this fqn can't slip between our check and the row removal.
    // Stands in for missing FK constraints. Throwing
    // `HasDependentsError` inside the transaction rolls back the empty
    // delete and propagates to the caller.
    //
    // Skills/mcps cannot depend on agents (skill codec has no
    // `agents` kind, and agents are not a CatalogKind for mcp deps),
    // so the only reverse-dep table to scan is `agent_agent_dependencies`.
    this.db.transaction((tx) => {
      const agentDeps = tx
        .select({ sourceFqn: agentAgentDeps.sourceFqn })
        .from(agentAgentDeps)
        .where(eq(agentAgentDeps.targetFqn, fqn))
        .orderBy(agentAgentDeps.sourceFqn)
        .all();
      if (agentDeps.length > 0) {
        throw new HasDependentsError(
          fqn,
          agentDeps.map((r) => ({ kind: "agent" as const, name: r.sourceFqn })),
        );
      }
      tx.delete(agentFiles).where(eq(agentFiles.agentFqn, fqn)).run();
      tx.delete(agentSkillDeps).where(eq(agentSkillDeps.sourceFqn, fqn)).run();
      tx.delete(agentMcpDeps).where(eq(agentMcpDeps.sourceFqn, fqn)).run();
      tx.delete(agentAgentDeps).where(eq(agentAgentDeps.sourceFqn, fqn)).run();
      tx.delete(agents).where(eq(agents.fqn, fqn)).run();
    });
  }

  async *streamFiles(fqn: string): AsyncIterable<AgentFile> {
    const rows = this.db.select().from(agentFiles).where(eq(agentFiles.agentFqn, fqn)).all();
    for (const row of rows) {
      yield { relPath: row.relPath, content: toBuf(row.content) };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = this.db
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.agentFqn, fqn), eq(agentFiles.relPath, "AGENTS.md")))
      .get();
    if (row === undefined) throw new AgentNotFoundError(fqn);
    return toBuf(row.content).toString("utf8");
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
    const agentRows = this.db
      .select({ targetFqn: agentAgentDeps.targetFqn })
      .from(agentAgentDeps)
      .where(eq(agentAgentDeps.sourceFqn, fqn))
      .orderBy(agentAgentDeps.targetFqn)
      .all();
    return {
      skills: skillRows.map((r) => ({ fqn: r.targetFqn })),
      mcps: mcpRows.map((r) => ({ fqn: r.targetFqn })),
      agents: agentRows.map((r) => ({ fqn: r.targetFqn })),
    };
  }

  /**
   * Reverse-dep lookup for agents that depend on `targetFqn` via the
   * `dependencies.agents` field. Mirrors `SkillRepository.findDependentAgents`
   * by intent — agent and skill keep independent reverse-dep helpers
   * per the per-kind autonomy axiom.
   */
  async findDependentAgents(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .select({ sourceFqn: agentAgentDeps.sourceFqn })
      .from(agentAgentDeps)
      .where(eq(agentAgentDeps.targetFqn, targetFqn))
      .orderBy(agentAgentDeps.sourceFqn)
      .all();
    return rows.map((r) => r.sourceFqn);
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
    const agentRows = this.db
      .select({
        sourceFqn: agentAgentDeps.sourceFqn,
        targetFqn: agentAgentDeps.targetFqn,
      })
      .from(agentAgentDeps)
      .orderBy(agentAgentDeps.sourceFqn, agentAgentDeps.targetFqn)
      .all();
    // Aggregate flat dep rows into `Map<sourceFqn, AgentDependencies>`.
    // Per-kind inlining (groupBy-style) — the only shared module is
    // `_shared/dep-keys.ts` which names no agent-specific concept.
    // All three source lists are already ordered by (sourceFqn, targetFqn),
    // so the per-source arrays stay sorted.
    type Bucket = {
      skills: { fqn: string }[];
      mcps: { fqn: string }[];
      agents: { fqn: string }[];
    };
    const out = new Map<string, Bucket>();
    function ensure(sourceFqn: string): Bucket {
      const existing = out.get(sourceFqn);
      if (existing !== undefined) return existing;
      const fresh: Bucket = { skills: [], mcps: [], agents: [] };
      out.set(sourceFqn, fresh);
      return fresh;
    }
    for (const r of skillRows) ensure(r.sourceFqn).skills.push({ fqn: r.targetFqn });
    for (const r of mcpRows) ensure(r.sourceFqn).mcps.push({ fqn: r.targetFqn });
    for (const r of agentRows) ensure(r.sourceFqn).agents.push({ fqn: r.targetFqn });
    return out as Map<string, AgentDependencies>;
  }
}

/** Normalise the drizzle blob shape — `better-sqlite3` may surface `Uint8Array`. */
function toBuf(content: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
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

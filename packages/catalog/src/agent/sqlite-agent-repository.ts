import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { Agent, type AgentDependencies } from "./agent-entity.js";
import type { AgentFile, AgentRepoAddDeps, AgentRepository } from "./agent-repository.js";
import { AgentNotFoundError } from "./errors.js";

const AGENT_PKG_SCHEMA_VERSION = 2;

/**
 * SQLite-backed `AgentRepository` (catalog v2 — issue #122).
 *
 * Schema lives in `agents` / `agent_files` / `agent_skill_dependencies`
 * / `agent_mcp_dependencies`. `scope` / `short_name` / `anchor_content`
 * / `deps_json` were dropped in v2 — derive from `fqn`, fetch anchor
 * via `getAnchor`, query dep tables for the M:N graph.
 */
export class SqliteAgentRepository implements AgentRepository {
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
    const upsertAgent = this.db.prepare(
      `INSERT INTO agents (fqn, origin, description, version, prereqs, prereqs_ack, disabled_by_user, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fqn) DO UPDATE SET
         origin = excluded.origin,
         description = excluded.description,
         version = excluded.version,
         prereqs = excluded.prereqs,
         prereqs_ack = excluded.prereqs_ack,
         disabled_by_user = excluded.disabled_by_user,
         updated_at = excluded.updated_at`,
    );
    const deleteFiles = this.db.prepare("DELETE FROM agent_files WHERE agent_fqn = ?");
    const insertFile = this.db.prepare(
      "INSERT INTO agent_files (agent_fqn, rel_path, content) VALUES (?, ?, ?)",
    );
    const deleteSkillDeps = this.db.prepare(
      "DELETE FROM agent_skill_dependencies WHERE source_fqn = ?",
    );
    const deleteMcpDeps = this.db.prepare(
      "DELETE FROM agent_mcp_dependencies WHERE source_fqn = ?",
    );
    const insertSkillDep = this.db.prepare(
      "INSERT INTO agent_skill_dependencies (source_fqn, target_fqn) VALUES (?, ?)",
    );
    const insertMcpDep = this.db.prepare(
      "INSERT INTO agent_mcp_dependencies (source_fqn, target_fqn) VALUES (?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      upsertAgent.run(
        agent.fqn,
        agent.origin,
        agent.description,
        agent.version,
        agent.prereqs ?? null,
        agent.prereqsAck ? 1 : 0,
        agent.disabledByUser ? 1 : 0,
        now,
        now,
      );
      deleteFiles.run(agent.fqn);
      for (const [relPath, content] of files) {
        insertFile.run(agent.fqn, relPath, content);
      }
      deleteSkillDeps.run(agent.fqn);
      deleteMcpDeps.run(agent.fqn);
      const seenSkill = new Set<string>();
      for (const targetFqn of deps.skills) {
        if (seenSkill.has(targetFqn)) continue;
        seenSkill.add(targetFqn);
        insertSkillDep.run(agent.fqn, targetFqn);
      }
      const seenMcp = new Set<string>();
      for (const targetFqn of deps.mcps) {
        if (seenMcp.has(targetFqn)) continue;
        seenMcp.add(targetFqn);
        insertMcpDep.run(agent.fqn, targetFqn);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async findByFqn(fqn: string): Promise<Agent | null> {
    const row = this.db
      .prepare(
        "SELECT origin, description, version, prereqs, prereqs_ack, disabled_by_user, installed_at, updated_at FROM agents WHERE fqn = ?",
      )
      .get(fqn) as AgentRow | undefined;
    if (row === undefined) return null;
    const deps = await this.listDependencies(fqn);
    return rowToAgent(fqn, row, deps);
  }

  async findByOrigin(origin: string): Promise<Agent | null> {
    const row = this.db
      .prepare(
        "SELECT fqn, description, version, prereqs, prereqs_ack, disabled_by_user, installed_at, updated_at FROM agents WHERE origin = ? LIMIT 1",
      )
      .get(origin) as (AgentRow & { fqn: string }) | undefined;
    if (row === undefined) return null;
    const deps = await this.listDependencies(row.fqn);
    return Agent.fromStored({
      fqn: row.fqn,
      origin,
      description: row.description,
      version: row.version,
      prereqs: row.prereqs ?? undefined,
      dependencies: deps,
      prereqsAck: row.prereqs_ack !== 0,
      disabledByUser: row.disabled_by_user !== 0,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    });
  }

  async findAll(): Promise<Agent[]> {
    const rows = this.db
      .prepare(
        "SELECT fqn, origin, description, version, prereqs, prereqs_ack, disabled_by_user, installed_at, updated_at FROM agents ORDER BY fqn",
      )
      .all() as unknown as (AgentRow & { fqn: string; origin: string })[];
    const depsByFqn = this.loadAllDeps();
    const out: Agent[] = [];
    for (const row of rows) {
      try {
        const deps = depsByFqn.get(row.fqn) ?? { skills: [], mcps: [] };
        out.push(
          Agent.fromStored({
            fqn: row.fqn,
            origin: row.origin,
            description: row.description,
            version: row.version,
            prereqs: row.prereqs ?? undefined,
            dependencies: deps,
            prereqsAck: row.prereqs_ack !== 0,
            disabledByUser: row.disabled_by_user !== 0,
            installedAt: row.installed_at,
            updatedAt: row.updated_at,
          }),
        );
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
    this.db.prepare("DELETE FROM agents WHERE fqn = ?").run(fqn);
  }

  async *streamFiles(fqn: string): AsyncIterable<AgentFile> {
    const rows = this.db
      .prepare("SELECT rel_path, content FROM agent_files WHERE agent_fqn = ?")
      .all(fqn) as { rel_path: string; content: Uint8Array }[];
    for (const row of rows) {
      yield {
        relPath: row.rel_path,
        content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
      };
    }
  }

  async getAnchor(fqn: string): Promise<string> {
    const row = this.db
      .prepare("SELECT content FROM agent_files WHERE agent_fqn = ? AND rel_path = 'AGENTS.md'")
      .get(fqn) as { content: Uint8Array } | undefined;
    if (row === undefined) throw new AgentNotFoundError(fqn);
    const buf = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    return buf.toString("utf8");
  }

  async listDependencies(fqn: string): Promise<AgentDependencies> {
    const skillRows = this.db
      .prepare(
        "SELECT target_fqn FROM agent_skill_dependencies WHERE source_fqn = ? ORDER BY target_fqn",
      )
      .all(fqn) as unknown as { target_fqn: string }[];
    const mcpRows = this.db
      .prepare(
        "SELECT target_fqn FROM agent_mcp_dependencies WHERE source_fqn = ? ORDER BY target_fqn",
      )
      .all(fqn) as unknown as { target_fqn: string }[];
    return {
      skills: skillRows.map((r) => ({ fqn: r.target_fqn })),
      mcps: mcpRows.map((r) => ({ fqn: r.target_fqn })),
    };
  }

  async setFlags(
    fqn: string,
    flags: { prereqsAck?: boolean; disabledByUser?: boolean },
  ): Promise<void> {
    const sets: string[] = [];
    const args: (number | string)[] = [];
    if (flags.prereqsAck !== undefined) {
      sets.push("prereqs_ack = ?");
      args.push(flags.prereqsAck ? 1 : 0);
    }
    if (flags.disabledByUser !== undefined) {
      sets.push("disabled_by_user = ?");
      args.push(flags.disabledByUser ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    args.push(new Date().toISOString());
    args.push(fqn);
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE fqn = ?`).run(...args);
  }

  private loadAllDeps(): Map<string, AgentDependencies> {
    const out = new Map<string, AgentDependencies>();
    const skillRows = this.db
      .prepare(
        "SELECT source_fqn, target_fqn FROM agent_skill_dependencies ORDER BY source_fqn, target_fqn",
      )
      .all() as unknown as { source_fqn: string; target_fqn: string }[];
    const mcpRows = this.db
      .prepare(
        "SELECT source_fqn, target_fqn FROM agent_mcp_dependencies ORDER BY source_fqn, target_fqn",
      )
      .all() as unknown as { source_fqn: string; target_fqn: string }[];
    for (const r of skillRows) {
      const e = out.get(r.source_fqn) ?? { skills: [], mcps: [] };
      out.set(r.source_fqn, {
        skills: [...e.skills, { fqn: r.target_fqn }],
        mcps: e.mcps,
      });
    }
    for (const r of mcpRows) {
      const e = out.get(r.source_fqn) ?? { skills: [], mcps: [] };
      out.set(r.source_fqn, {
        skills: e.skills,
        mcps: [...e.mcps, { fqn: r.target_fqn }],
      });
    }
    return out;
  }

  private ensureSchema(): void {
    let existing: { version: number } | undefined;
    try {
      existing = this.db
        .prepare("SELECT version FROM schema_meta WHERE pkg = ?")
        .get("catalog_agent") as { version: number } | undefined;
    } catch {
      throw new SchemaMetaNotBootstrappedError("catalog_agent");
    }
    if (existing === undefined) {
      throw new SchemaMetaNotBootstrappedError("catalog_agent");
    }
    if (existing.version !== AGENT_PKG_SCHEMA_VERSION) {
      throw new SchemaMetaMismatchError(
        "catalog_agent",
        existing.version,
        AGENT_PKG_SCHEMA_VERSION,
      );
    }
  }
}

interface AgentRow {
  origin: string;
  description: string;
  version: string;
  prereqs: string | null;
  prereqs_ack: number;
  disabled_by_user: number;
  installed_at: string;
  updated_at: string;
}

function rowToAgent(fqn: string, row: AgentRow, deps: AgentDependencies): Agent {
  return Agent.fromStored({
    fqn,
    origin: row.origin,
    description: row.description,
    version: row.version,
    prereqs: row.prereqs ?? undefined,
    dependencies: deps,
    prereqsAck: row.prereqs_ack !== 0,
    disabledByUser: row.disabled_by_user !== 0,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  });
}

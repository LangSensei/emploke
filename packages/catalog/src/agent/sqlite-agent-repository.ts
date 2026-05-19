import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { Agent, type AgentDependencies } from "./agent-entity.js";
import type { AgentFile, AgentRepository } from "./agent-repository.js";

const AGENT_PKG_SCHEMA_VERSION = 1;

/**
 * SQLite-backed `AgentRepository`. Mirror of {@link SqliteSkillRepository}
 * with `agent` / `agent_file` tables instead.
 *
 * The constructor takes an already-opened `DatabaseSync`. The server
 * shares one connection across every per-workspace repository
 * (task / session / catalog / workflow); the file handle count per
 * workspace stays at one. PRAGMAs (journal_mode, synchronous,
 * foreign_keys, ...) are the caller's responsibility — the workspace
 * pkg sets them once on the shared connection.
 *
 * Schema versioning is per-pkg: this repo writes its own row to
 * `schema_meta` keyed by `pkg='catalog_agent'`, sibling to the rows
 * written by `SqliteSkillRepository` (`catalog_skill`) and
 * `SqliteMcpRepository` (`catalog_mcp`).
 */
export class SqliteAgentRepository implements AgentRepository {
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

  async add(agent: Agent, files: ReadonlyMap<string, Buffer>): Promise<void> {
    if (!files.has("AGENTS.md")) {
      throw new TypeError(
        `AgentRepository.add requires AGENTS.md in the files map (got: ${[...files.keys()].join(", ")})`,
      );
    }
    const upsertAgent = this.db.prepare(
      `INSERT INTO agent (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack, disabled_by_user)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fqn) DO UPDATE SET
         origin = excluded.origin,
         scope = excluded.scope,
         short_name = excluded.short_name,
         description = excluded.description,
         version = excluded.version,
         prereqs = excluded.prereqs,
         deps_json = excluded.deps_json,
         anchor_content = excluded.anchor_content,
         prereqs_ack = excluded.prereqs_ack,
         disabled_by_user = excluded.disabled_by_user`,
    );
    const deleteFiles = this.db.prepare("DELETE FROM agent_file WHERE agent_fqn = ?");
    const insertFile = this.db.prepare(
      "INSERT INTO agent_file (agent_fqn, rel_path, content) VALUES (?, ?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      upsertAgent.run(
        agent.fqn,
        agent.origin,
        agent.scope,
        agent.shortName,
        agent.description,
        agent.version,
        agent.prereqs ?? null,
        JSON.stringify(agent.dependencies),
        agent.anchorContent,
        agent.prereqsAck ? 1 : 0,
        agent.disabledByUser ? 1 : 0,
      );
      deleteFiles.run(agent.fqn);
      for (const [relPath, content] of files) {
        insertFile.run(agent.fqn, relPath, content);
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
        "SELECT origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack, disabled_by_user FROM agent WHERE fqn = ?",
      )
      .get(fqn) as AgentRow | undefined;
    if (row === undefined) return null;
    return rowToAgent(fqn, row);
  }

  async findByOrigin(origin: string): Promise<Agent | null> {
    const row = this.db
      .prepare(
        "SELECT fqn, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack, disabled_by_user FROM agent WHERE origin = ? LIMIT 1",
      )
      .get(origin) as (AgentRow & { fqn: string }) | undefined;
    if (row === undefined) return null;
    return Agent.fromStored({
      fqn: row.fqn,
      origin,
      scope: row.scope,
      shortName: row.short_name,
      description: row.description,
      version: row.version,
      prereqs: row.prereqs ?? undefined,
      dependencies: parseDeps(row.deps_json),
      anchorContent: row.anchor_content,
      prereqsAck: row.prereqs_ack !== 0,
      disabledByUser: row.disabled_by_user !== 0,
    });
  }

  async findAll(): Promise<Agent[]> {
    const rows = this.db
      .prepare(
        "SELECT fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack, disabled_by_user FROM agent ORDER BY fqn",
      )
      .all() as unknown as (AgentRow & { fqn: string })[];
    const out: Agent[] = [];
    for (const row of rows) {
      try {
        out.push(
          Agent.fromStored({
            fqn: row.fqn,
            origin: row.origin,
            scope: row.scope,
            shortName: row.short_name,
            description: row.description,
            version: row.version,
            prereqs: row.prereqs ?? undefined,
            dependencies: parseDeps(row.deps_json),
            anchorContent: row.anchor_content,
            prereqsAck: row.prereqs_ack !== 0,
            disabledByUser: row.disabled_by_user !== 0,
          }),
        );
      } catch (cause) {
        // Skip rows with FQNs that fail validation. See
        // SqliteSkillRepository.findAll for rationale.
        this.logger.warn(
          {
            fqn: row.fqn ?? null,
            cause: (cause as Error).message,
          },
          "catalog/agent: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  async delete(fqn: string): Promise<void> {
    this.db.prepare("DELETE FROM agent WHERE fqn = ?").run(fqn);
  }

  async *streamFiles(fqn: string): AsyncIterable<AgentFile> {
    const rows = this.db
      .prepare("SELECT rel_path, content FROM agent_file WHERE agent_fqn = ?")
      .all(fqn) as { rel_path: string; content: Uint8Array }[];
    for (const row of rows) {
      yield {
        relPath: row.rel_path,
        content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
      };
    }
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
    args.push(fqn);
    this.db.prepare(`UPDATE agent SET ${sets.join(", ")} WHERE fqn = ?`).run(...args);
  }

  // ─── schema management ──────────────────────────────────────

  private ensureSchema(): void {
    // Post-issue-#123: the MigrationCoordinator owns DDL. This
    // repository's job is to assert the post-condition — a
    // `schema_meta` row for the `catalog_agent` pkg at the expected
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
        .get("catalog_agent") as { version: number } | undefined;
    } catch {
      // `schema_meta` itself missing → coordinator never ran.
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
  scope: string;
  short_name: string;
  description: string;
  version: string;
  prereqs: string | null;
  deps_json: string;
  anchor_content: string;
  prereqs_ack: number;
  disabled_by_user: number;
}

function rowToAgent(fqn: string, row: AgentRow): Agent {
  return Agent.fromStored({
    fqn,
    origin: row.origin,
    scope: row.scope,
    shortName: row.short_name,
    description: row.description,
    version: row.version,
    prereqs: row.prereqs ?? undefined,
    dependencies: parseDeps(row.deps_json),
    anchorContent: row.anchor_content,
    prereqsAck: row.prereqs_ack !== 0,
    disabledByUser: row.disabled_by_user !== 0,
  });
}

function parseDeps(json: string): AgentDependencies {
  try {
    const parsed = JSON.parse(json) as Partial<AgentDependencies>;
    return {
      skills: parsed.skills ?? [],
      mcps: parsed.mcps ?? [],
    };
  } catch {
    return { skills: [], mcps: [] };
  }
}

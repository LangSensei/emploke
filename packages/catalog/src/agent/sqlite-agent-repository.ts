import { DatabaseSync } from "node:sqlite";
import { tableHasLegacyShape } from "../skill/sqlite-skill-repository.js";
import { Agent, type AgentDependencies } from "./agent-entity.js";
import type { AgentFile, AgentRepository } from "./agent-repository.js";

/**
 * SQLite-backed `AgentRepository`. Mirror of {@link SqliteSkillRepository}
 * with `agent` / `agent_file` tables instead.
 */
export class SqliteAgentRepository implements AgentRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // See SqliteSkillRepository for the rationale on dropping legacy
    // pre-`fqn`-rename schemas instead of carrying ALTER TABLE migrations.
    if (tableHasLegacyShape(this.db, "agent", "fqn")) {
      this.db.exec("DROP TABLE IF EXISTS agent_file");
      this.db.exec("DROP TABLE IF EXISTS agent");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent (
        fqn            TEXT PRIMARY KEY NOT NULL,
        origin         TEXT NOT NULL,
        scope          TEXT NOT NULL,
        short_name     TEXT NOT NULL,
        description    TEXT NOT NULL,
        version        TEXT NOT NULL,
        deps_json      TEXT NOT NULL,
        anchor_content TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS agent_origin ON agent(origin)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_file (
        agent_fqn  TEXT NOT NULL REFERENCES agent(fqn) ON DELETE CASCADE,
        rel_path   TEXT NOT NULL,
        content    BLOB NOT NULL,
        PRIMARY KEY (agent_fqn, rel_path)
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  async add(agent: Agent, files: ReadonlyMap<string, Buffer>): Promise<void> {
    if (!files.has("AGENTS.md")) {
      throw new TypeError(
        `AgentRepository.add requires AGENTS.md in the files map (got: ${[...files.keys()].join(", ")})`,
      );
    }
    const upsertAgent = this.db.prepare(
      `INSERT INTO agent (fqn, origin, scope, short_name, description, version, deps_json, anchor_content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fqn) DO UPDATE SET
         origin = excluded.origin,
         scope = excluded.scope,
         short_name = excluded.short_name,
         description = excluded.description,
         version = excluded.version,
         deps_json = excluded.deps_json,
         anchor_content = excluded.anchor_content`,
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
        JSON.stringify(agent.dependencies),
        agent.anchorContent,
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
        "SELECT origin, scope, short_name, description, version, deps_json, anchor_content FROM agent WHERE fqn = ?",
      )
      .get(fqn) as AgentRow | undefined;
    if (row === undefined) return null;
    return rowToAgent(fqn, row);
  }

  async findByOrigin(origin: string): Promise<Agent | null> {
    const row = this.db
      .prepare(
        "SELECT fqn, scope, short_name, description, version, deps_json, anchor_content FROM agent WHERE origin = ? LIMIT 1",
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
      dependencies: parseDeps(row.deps_json),
      anchorContent: row.anchor_content,
    });
  }

  async findAll(): Promise<Agent[]> {
    const rows = this.db
      .prepare(
        "SELECT fqn, origin, scope, short_name, description, version, deps_json, anchor_content FROM agent ORDER BY fqn",
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
            dependencies: parseDeps(row.deps_json),
            anchorContent: row.anchor_content,
          }),
        );
      } catch {
        // Skip rows with FQNs that fail validation.
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
}

interface AgentRow {
  origin: string;
  scope: string;
  short_name: string;
  description: string;
  version: string;
  deps_json: string;
  anchor_content: string;
}

function rowToAgent(fqn: string, row: AgentRow): Agent {
  return Agent.fromStored({
    fqn,
    origin: row.origin,
    scope: row.scope,
    shortName: row.short_name,
    description: row.description,
    version: row.version,
    dependencies: parseDeps(row.deps_json),
    anchorContent: row.anchor_content,
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

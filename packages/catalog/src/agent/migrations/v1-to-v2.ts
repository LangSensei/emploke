import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "@emploke/workspace";

/**
 * Migrate `catalog_agent` from v1 → v2 for issue #122.
 *
 * Mirror of {@link import("../../skill/migrations/v1-to-v2.js").v1To2}
 * with these schema-level differences:
 *
 *   - Retains the `disabled_by_user` flag (agents are user-launchable
 *     execution units; the equivalent does not exist for skills).
 *   - Dep tables are `agent_skill_dependencies` and
 *     `agent_mcp_dependencies` — no agent-to-agent edges (agents are
 *     root entities, never dep-referenced from elsewhere in the
 *     catalog graph).
 *   - No self-loop CHECK needed for the same reason.
 *
 * Cross-pkg dependency: `dependsOn: ["catalog_skill:2", "catalog_mcp:2"]`
 * because both `*_dependencies.target_fqn` columns FK-reference the
 * v2 sibling tables, and the origin → fqn backfill resolves against
 * the v2 `skills` and `mcps` tables.
 *
 * Migration mechanics: identical to the skill v1→v2 migration —
 * stash `(fqn, deps_json)` in a temporary `_agent_deps_v1` table
 * inside `schemaSQL`, then the {@link backfill} hook reads from it,
 * resolves origins to fqns, INSERTs into the new dep tables, and
 * drops the scratch table. Coordinator wraps the whole thing in a
 * single `BEGIN IMMEDIATE`, so partial failure rolls back atomically.
 */
export const v1To2: Migration = {
  pkg: "catalog_agent",
  fromVersion: 1,
  toVersion: 2,
  dependsOn: ["catalog_skill:2", "catalog_mcp:2"],
  schemaSQL: `
    CREATE TABLE _agent_deps_v1 AS
      SELECT fqn, deps_json FROM agent;

    CREATE TABLE agents_v2 (
      fqn              TEXT PRIMARY KEY NOT NULL,
      origin           TEXT NOT NULL,
      description      TEXT NOT NULL,
      version          TEXT NOT NULL,
      prereqs          TEXT,
      prereqs_ack      INTEGER NOT NULL DEFAULT 1,
      disabled_by_user INTEGER NOT NULL DEFAULT 0,
      installed_at     TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    INSERT INTO agents_v2 (
      fqn, origin, description, version, prereqs, prereqs_ack,
      disabled_by_user, installed_at, updated_at
    )
      SELECT
        fqn, origin, description, version, prereqs, prereqs_ack,
        disabled_by_user,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS installed_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS updated_at
      FROM agent;
    DROP TABLE agent;
    ALTER TABLE agents_v2 RENAME TO agents;
    CREATE INDEX agents_origin     ON agents(origin);
    CREATE INDEX agents_updated_at ON agents(updated_at DESC);

    -- Rebuild agent_files so its FK targets the new agents table.
    -- SQLite ALTER ... RENAME preserves the original REFERENCES
    -- agent(fqn) text, which would dangle once we DROP agent.
    ALTER TABLE agent_file RENAME TO _agent_files_v1;
    CREATE TABLE agent_files (
      agent_fqn  TEXT NOT NULL REFERENCES agents(fqn) ON DELETE CASCADE,
      rel_path   TEXT NOT NULL,
      content    BLOB NOT NULL,
      PRIMARY KEY (agent_fqn, rel_path)
    );
    INSERT INTO agent_files (agent_fqn, rel_path, content)
      SELECT agent_fqn, rel_path, content FROM _agent_files_v1;
    DROP TABLE _agent_files_v1;

    CREATE TABLE agent_skill_dependencies (
      source_fqn TEXT NOT NULL REFERENCES agents(fqn) ON DELETE CASCADE,
      target_fqn TEXT NOT NULL REFERENCES skills(fqn) ON DELETE RESTRICT,
      PRIMARY KEY (source_fqn, target_fqn)
    );
    CREATE INDEX agent_skill_dependencies_reverse
      ON agent_skill_dependencies(target_fqn);

    CREATE TABLE agent_mcp_dependencies (
      source_fqn TEXT NOT NULL REFERENCES agents(fqn) ON DELETE CASCADE,
      target_fqn TEXT NOT NULL REFERENCES mcps(fqn)   ON DELETE RESTRICT,
      PRIMARY KEY (source_fqn, target_fqn)
    );
    CREATE INDEX agent_mcp_dependencies_reverse
      ON agent_mcp_dependencies(target_fqn);
  `,
  backfill: (db: DatabaseSync) => {
    backfillAgentDeps(db);
  },
};

interface DepBlob {
  fqn: string;
  deps_json: string;
}

interface DepShape {
  skills?: readonly string[];
  mcps?: readonly string[];
}

function backfillAgentDeps(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT fqn, deps_json FROM _agent_deps_v1")
    .all() as unknown as DepBlob[];
  const skillFqnByOrigin = collectFqnsByOrigin(db, "skills");
  const mcpFqnByOrigin = collectFqnsByOrigin(db, "mcps");
  const insertSkillDep = db.prepare(
    `INSERT OR IGNORE INTO agent_skill_dependencies (source_fqn, target_fqn) VALUES (?, ?)`,
  );
  const insertMcpDep = db.prepare(
    `INSERT OR IGNORE INTO agent_mcp_dependencies (source_fqn, target_fqn) VALUES (?, ?)`,
  );
  for (const row of rows) {
    const deps = parseDeps(row.deps_json);
    for (const origin of deps.skills ?? []) {
      const targetFqn = skillFqnByOrigin.get(origin);
      if (targetFqn === undefined) continue;
      insertSkillDep.run(row.fqn, targetFqn);
    }
    for (const origin of deps.mcps ?? []) {
      const targetFqn = mcpFqnByOrigin.get(origin);
      if (targetFqn === undefined) continue;
      insertMcpDep.run(row.fqn, targetFqn);
    }
  }
  db.exec("DROP TABLE _agent_deps_v1");
}

function collectFqnsByOrigin(db: DatabaseSync, table: "skills" | "mcps"): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.prepare(`SELECT fqn, origin FROM ${table}`).all() as unknown as {
    fqn: string;
    origin: string;
  }[];
  for (const row of rows) out.set(row.origin, row.fqn);
  return out;
}

function parseDeps(json: string): DepShape {
  if (typeof json !== "string" || json.length === 0) return {};
  try {
    const parsed = JSON.parse(json) as DepShape | undefined;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

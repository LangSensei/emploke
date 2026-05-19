import { DatabaseSync } from "node:sqlite";
import { runPkgMigrations } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_MIGRATIONS } from "../../src/agent/migrations/index.js";
import { MCP_MIGRATIONS } from "../../src/mcp/migrations/index.js";
import { SKILL_MIGRATIONS } from "../../src/skill/migrations/index.js";

/**
 * End-to-end test for the catalog v1 → v2 migration (issue #122).
 * Seeds a populated v1 schema directly via SQL (bypassing the
 * repositories, which now expect v2), runs the three pkg migrations
 * through the coordinator, and asserts the resulting v2 state:
 *
 *   - tables renamed to plural;
 *   - dropped denormalisations (`scope`, `short_name`, `anchor_content`,
 *     `deps_json`) are gone;
 *   - `installed_at` + `updated_at` columns populated;
 *   - mcp columns renamed (`name` → `fqn`, `content` → `spec`);
 *   - dep tables populated correctly from the v1 `deps_json` origin
 *     arrays via the cross-pkg backfill (`agent_skill_dependencies`,
 *     `agent_mcp_dependencies`, `skill_skill_dependencies`,
 *     `skill_mcp_dependencies`);
 *   - FK enforcement engages post-migration (target `RESTRICT` blocks
 *     deletion of depended-on entries);
 *   - skill self-loop CHECK rejects pathological rows;
 *   - `json_valid(spec)` CHECK rejects malformed MCP JSON.
 *
 * Cross-pkg ordering: `catalog_agent` `dependsOn ["catalog_skill:2",
 * "catalog_mcp:2"]` so the topo sort guarantees the sibling tables
 * exist + are populated before the agent backfill runs origin → fqn
 * lookups against them.
 */
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

function seedCatalogV1Schema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE schema_meta (
      pkg     TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );
    CREATE TABLE agent (
      fqn              TEXT PRIMARY KEY NOT NULL,
      origin           TEXT NOT NULL,
      scope            TEXT NOT NULL,
      short_name       TEXT NOT NULL,
      description      TEXT NOT NULL,
      version          TEXT NOT NULL,
      prereqs          TEXT,
      deps_json        TEXT NOT NULL,
      anchor_content   TEXT NOT NULL,
      prereqs_ack      INTEGER NOT NULL DEFAULT 1,
      disabled_by_user INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX agent_origin ON agent(origin);
    CREATE TABLE agent_file (
      agent_fqn  TEXT NOT NULL REFERENCES agent(fqn) ON DELETE CASCADE,
      rel_path   TEXT NOT NULL,
      content    BLOB NOT NULL,
      PRIMARY KEY (agent_fqn, rel_path)
    );
    CREATE TABLE skill (
      fqn            TEXT PRIMARY KEY NOT NULL,
      origin         TEXT NOT NULL,
      scope          TEXT NOT NULL,
      short_name     TEXT NOT NULL,
      description    TEXT NOT NULL,
      version        TEXT NOT NULL,
      prereqs        TEXT,
      deps_json      TEXT NOT NULL,
      anchor_content TEXT NOT NULL,
      prereqs_ack    INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX skill_origin ON skill(origin);
    CREATE TABLE skill_file (
      skill_fqn  TEXT NOT NULL REFERENCES skill(fqn) ON DELETE CASCADE,
      rel_path   TEXT NOT NULL,
      content    BLOB NOT NULL,
      PRIMARY KEY (skill_fqn, rel_path)
    );
    CREATE TABLE mcp (
      name      TEXT PRIMARY KEY NOT NULL,
      origin    TEXT NOT NULL,
      content   TEXT NOT NULL
    );
    INSERT INTO schema_meta (pkg, version) VALUES
      ('catalog_agent', 1),
      ('catalog_skill', 1),
      ('catalog_mcp',   1);
  `);
}

const MCP_SPEC = '{"_meta":{"name":"acme/db"},"version":"1.0.0"}';
const AGENT_BODY =
  "---\nname: writer\nscope: public\nversion: 1.0.0\ndescription: w\n---\n# writer\n";
const SKILL_BODY =
  "---\nname: web-search\nscope: public\nversion: 1.0.0\ndescription: s\n---\n# skill\n";
const SKILL_DEP_BODY =
  "---\nname: tool-use\nscope: public\nversion: 1.0.0\ndescription: t\n---\n# tool\n";

async function runMigrations(d: DatabaseSync) {
  return runPkgMigrations(d, [
    { pkg: "catalog_agent", migrations: AGENT_MIGRATIONS },
    { pkg: "catalog_skill", migrations: SKILL_MIGRATIONS },
    { pkg: "catalog_mcp", migrations: MCP_MIGRATIONS },
  ]);
}

describe("catalog v1 → v2 migration (issue #122) — schema shape", () => {
  it("renames tables to plural, drops denormalised columns, adds timestamps + new indexes", async () => {
    seedCatalogV1Schema(db);
    db.prepare(
      `INSERT INTO agent (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack, disabled_by_user)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, 0)`,
    ).run(
      "public/writer",
      "file:/abs/agents/writer",
      "public",
      "writer",
      "writer description",
      "1.0.0",
      "{}",
      AGENT_BODY,
    );
    db.prepare(
      `INSERT INTO skill (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).run(
      "public/web-search",
      "file:/abs/skills/web-search",
      "public",
      "web-search",
      "skill",
      "1.0.0",
      "{}",
      SKILL_BODY,
    );
    db.prepare(`INSERT INTO mcp (name, origin, content) VALUES (?, ?, ?)`).run(
      "acme/db",
      "file:/abs/mcps/acme_db.json",
      MCP_SPEC,
    );

    await runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("agents");
    expect(tables).toContain("agent_files");
    expect(tables).toContain("agent_skill_dependencies");
    expect(tables).toContain("agent_mcp_dependencies");
    expect(tables).toContain("skills");
    expect(tables).toContain("skill_files");
    expect(tables).toContain("skill_skill_dependencies");
    expect(tables).toContain("skill_mcp_dependencies");
    expect(tables).toContain("mcps");
    expect(tables).not.toContain("agent");
    expect(tables).not.toContain("agent_file");
    expect(tables).not.toContain("skill");
    expect(tables).not.toContain("skill_file");
    expect(tables).not.toContain("mcp");
    expect(tables).not.toContain("_agent_deps_v1");
    expect(tables).not.toContain("_skill_deps_v1");

    const agentCols = (db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(agentCols.sort()).toEqual(
      [
        "fqn",
        "origin",
        "description",
        "version",
        "prereqs",
        "prereqs_ack",
        "disabled_by_user",
        "installed_at",
        "updated_at",
      ].sort(),
    );

    const skillCols = (db.prepare("PRAGMA table_info(skills)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(skillCols.sort()).toEqual(
      [
        "fqn",
        "origin",
        "description",
        "version",
        "prereqs",
        "prereqs_ack",
        "installed_at",
        "updated_at",
      ].sort(),
    );

    const mcpCols = (db.prepare("PRAGMA table_info(mcps)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(mcpCols.sort()).toEqual(["fqn", "origin", "spec", "installed_at", "updated_at"].sort());

    const versions = db
      .prepare("SELECT pkg, version FROM schema_meta WHERE pkg LIKE 'catalog_%' ORDER BY pkg")
      .all() as { pkg: string; version: number }[];
    expect(versions).toEqual([
      { pkg: "catalog_agent", version: 2 },
      { pkg: "catalog_mcp", version: 2 },
      { pkg: "catalog_skill", version: 2 },
    ]);

    const agent = db.prepare("SELECT * FROM agents WHERE fqn = ?").get("public/writer") as {
      fqn: string;
      origin: string;
      description: string;
      installed_at: string;
      updated_at: string;
    };
    expect(agent.fqn).toBe("public/writer");
    expect(agent.origin).toBe("file:/abs/agents/writer");
    expect(agent.description).toBe("writer description");
    expect(agent.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    expect(agent.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);

    const mcp = db.prepare("SELECT * FROM mcps WHERE fqn = ?").get("acme/db") as {
      fqn: string;
      origin: string;
      spec: string;
    };
    expect(mcp.fqn).toBe("acme/db");
    expect(mcp.spec).toBe(MCP_SPEC);
  });

  it("idempotent: re-running against an already-v2 DB applies no migrations", async () => {
    seedCatalogV1Schema(db);
    await runMigrations(db);
    const result = await runMigrations(db);
    expect(result.applied).toEqual([]);
    expect([...result.alreadyAtTarget].sort()).toEqual([
      "catalog_agent",
      "catalog_mcp",
      "catalog_skill",
    ]);
  });
});

describe("catalog v1 → v2 migration — dep backfill via origin → fqn resolution", () => {
  it("populates all four dep tables from the v1 deps_json origin arrays", async () => {
    seedCatalogV1Schema(db);
    db.prepare(`INSERT INTO mcp (name, origin, content) VALUES (?, ?, ?)`).run(
      "acme/db",
      "file:/abs/mcps/acme_db.json",
      MCP_SPEC,
    );
    db.prepare(`INSERT INTO mcp (name, origin, content) VALUES (?, ?, ?)`).run(
      "acme/cache",
      "file:/abs/mcps/acme_cache.json",
      MCP_SPEC,
    );
    db.prepare(
      `INSERT INTO skill (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).run(
      "public/tool-use",
      "file:/abs/skills/tool-use",
      "public",
      "tool-use",
      "tool",
      "1.0.0",
      "{}",
      SKILL_DEP_BODY,
    );
    db.prepare(
      `INSERT INTO skill (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).run(
      "public/web-search",
      "file:/abs/skills/web-search",
      "public",
      "web-search",
      "skill",
      "1.0.0",
      JSON.stringify({
        skills: ["file:/abs/skills/tool-use"],
        mcps: ["file:/abs/mcps/acme_cache.json"],
      }),
      SKILL_BODY,
    );
    db.prepare(
      `INSERT INTO agent (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack, disabled_by_user)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, 0)`,
    ).run(
      "public/writer",
      "file:/abs/agents/writer",
      "public",
      "writer",
      "writer description",
      "1.0.0",
      JSON.stringify({
        skills: ["file:/abs/skills/web-search"],
        mcps: ["file:/abs/mcps/acme_db.json"],
      }),
      AGENT_BODY,
    );

    await runMigrations(db);

    const ask = db
      .prepare(
        "SELECT source_fqn, target_fqn FROM agent_skill_dependencies ORDER BY source_fqn, target_fqn",
      )
      .all() as { source_fqn: string; target_fqn: string }[];
    expect(ask).toEqual([{ source_fqn: "public/writer", target_fqn: "public/web-search" }]);

    const amk = db
      .prepare(
        "SELECT source_fqn, target_fqn FROM agent_mcp_dependencies ORDER BY source_fqn, target_fqn",
      )
      .all() as { source_fqn: string; target_fqn: string }[];
    expect(amk).toEqual([{ source_fqn: "public/writer", target_fqn: "acme/db" }]);

    const ssk = db
      .prepare(
        "SELECT source_fqn, target_fqn FROM skill_skill_dependencies ORDER BY source_fqn, target_fqn",
      )
      .all() as { source_fqn: string; target_fqn: string }[];
    expect(ssk).toEqual([{ source_fqn: "public/web-search", target_fqn: "public/tool-use" }]);

    const smk = db
      .prepare(
        "SELECT source_fqn, target_fqn FROM skill_mcp_dependencies ORDER BY source_fqn, target_fqn",
      )
      .all() as { source_fqn: string; target_fqn: string }[];
    expect(smk).toEqual([{ source_fqn: "public/web-search", target_fqn: "acme/cache" }]);
  });

  it("skips unresolvable origins silently (degraded v1 state tolerated)", async () => {
    seedCatalogV1Schema(db);
    db.prepare(
      `INSERT INTO skill (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).run(
      "public/web-search",
      "file:/abs/skills/web-search",
      "public",
      "web-search",
      "skill",
      "1.0.0",
      JSON.stringify({
        skills: ["file:/abs/skills/ghost"],
        mcps: ["file:/abs/mcps/ghost.json"],
      }),
      SKILL_BODY,
    );

    await runMigrations(db);

    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    expect(count("skill_skill_dependencies")).toBe(0);
    expect(count("skill_mcp_dependencies")).toBe(0);
  });

  it("tolerates malformed / empty deps_json (skip silently)", async () => {
    seedCatalogV1Schema(db);
    db.prepare(
      `INSERT INTO skill (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).run(
      "public/a",
      "file:/abs/skills/a",
      "public",
      "a",
      "a",
      "1.0.0",
      "garbage not json",
      SKILL_BODY,
    );
    db.prepare(
      `INSERT INTO skill (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).run("public/b", "file:/abs/skills/b", "public", "b", "b", "1.0.0", "", SKILL_BODY);

    await runMigrations(db);

    const count = (
      db.prepare(`SELECT COUNT(*) AS c FROM skill_skill_dependencies`).get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });
});

describe("catalog v1 → v2 migration — DB-level invariants", () => {
  async function seedAndMigrate(): Promise<void> {
    seedCatalogV1Schema(db);
    db.prepare(`INSERT INTO mcp (name, origin, content) VALUES (?, ?, ?)`).run(
      "acme/db",
      "file:/abs/mcps/acme_db.json",
      MCP_SPEC,
    );
    db.prepare(
      `INSERT INTO skill (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
    ).run(
      "public/web-search",
      "file:/abs/skills/web-search",
      "public",
      "web-search",
      "skill",
      "1.0.0",
      JSON.stringify({ mcps: ["file:/abs/mcps/acme_db.json"] }),
      SKILL_BODY,
    );
    await runMigrations(db);
    db.exec("PRAGMA foreign_keys = ON");
  }

  it("ON DELETE RESTRICT blocks deletion of a depended-on MCP", async () => {
    await seedAndMigrate();
    expect(() => db.prepare("DELETE FROM mcps WHERE fqn = ?").run("acme/db")).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("ON DELETE CASCADE removes dep rows when the source is deleted", async () => {
    await seedAndMigrate();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM skill_mcp_dependencies").get() as { c: number }).c,
    ).toBe(1);
    db.prepare("DELETE FROM skills WHERE fqn = ?").run("public/web-search");
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM skill_mcp_dependencies").get() as { c: number }).c,
    ).toBe(0);
  });

  it("skill_skill_dependencies CHECK rejects self-loops", async () => {
    await seedAndMigrate();
    db.prepare(
      `INSERT INTO skills (fqn, origin, description, version, prereqs, prereqs_ack, installed_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).run(
      "public/self",
      "file:/abs/skills/self",
      "self",
      "1.0.0",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    expect(() =>
      db
        .prepare("INSERT INTO skill_skill_dependencies (source_fqn, target_fqn) VALUES (?, ?)")
        .run("public/self", "public/self"),
    ).toThrow(/CHECK constraint failed/);
  });

  it("CHECK (json_valid(spec)) rejects non-JSON spec on mcps", async () => {
    await seedAndMigrate();
    expect(() =>
      db
        .prepare(
          `INSERT INTO mcps (fqn, origin, spec, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "garbage/x",
          "file:/abs/mcps/garbage.json",
          "not valid json at all",
          new Date().toISOString(),
          new Date().toISOString(),
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("origin + updated_at + reverse-dep indexes exist on all three main tables", async () => {
    await seedAndMigrate();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of [
      "agents_origin",
      "agents_updated_at",
      "skills_origin",
      "skills_updated_at",
      "mcps_origin",
      "mcps_updated_at",
      "agent_skill_dependencies_reverse",
      "agent_mcp_dependencies_reverse",
      "skill_skill_dependencies_reverse",
      "skill_mcp_dependencies_reverse",
    ]) {
      expect(indexes).toContain(expected);
    }
  });
});

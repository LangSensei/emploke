import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { SkillNotFoundError } from "./errors.js";
import { Skill, type SkillDependencies } from "./skill-entity.js";
import type { SkillFile, SkillRepoAddDeps, SkillRepository } from "./skill-repository.js";

const SKILL_PKG_SCHEMA_VERSION = 2;

/**
 * SQLite-backed `SkillRepository` (catalog v2 — issue #122). See
 * {@link SqliteAgentRepository} for the parallel notes. Differences:
 *   - no `disabled_by_user` flag
 *   - self-referential `skill_skill_dependencies` (1-node cycle
 *     CHECK enforced at DDL)
 */
export class SqliteSkillRepository implements SkillRepository {
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
    skill: Skill,
    files: ReadonlyMap<string, Buffer>,
    deps: SkillRepoAddDeps,
  ): Promise<void> {
    if (!files.has("SKILL.md")) {
      throw new TypeError(
        `SkillRepository.add requires SKILL.md in the files map (got: ${[...files.keys()].join(", ")})`,
      );
    }
    const now = new Date().toISOString();
    const upsertSkill = this.db.prepare(
      `INSERT INTO skills (fqn, origin, description, version, prereqs, prereqs_ack, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fqn) DO UPDATE SET
         origin = excluded.origin,
         description = excluded.description,
         version = excluded.version,
         prereqs = excluded.prereqs,
         prereqs_ack = excluded.prereqs_ack,
         updated_at = excluded.updated_at`,
    );
    const deleteFiles = this.db.prepare("DELETE FROM skill_files WHERE skill_fqn = ?");
    const insertFile = this.db.prepare(
      "INSERT INTO skill_files (skill_fqn, rel_path, content) VALUES (?, ?, ?)",
    );
    const deleteSkillDeps = this.db.prepare(
      "DELETE FROM skill_skill_dependencies WHERE source_fqn = ?",
    );
    const deleteMcpDeps = this.db.prepare(
      "DELETE FROM skill_mcp_dependencies WHERE source_fqn = ?",
    );
    const insertSkillDep = this.db.prepare(
      "INSERT INTO skill_skill_dependencies (source_fqn, target_fqn) VALUES (?, ?)",
    );
    const insertMcpDep = this.db.prepare(
      "INSERT INTO skill_mcp_dependencies (source_fqn, target_fqn) VALUES (?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      upsertSkill.run(
        skill.fqn,
        skill.origin,
        skill.description,
        skill.version,
        skill.prereqs ?? null,
        skill.prereqsAck ? 1 : 0,
        now,
        now,
      );
      deleteFiles.run(skill.fqn);
      for (const [relPath, content] of files) {
        insertFile.run(skill.fqn, relPath, content);
      }
      deleteSkillDeps.run(skill.fqn);
      deleteMcpDeps.run(skill.fqn);
      const seenSkill = new Set<string>();
      for (const targetFqn of deps.skills) {
        if (targetFqn === skill.fqn) continue;
        if (seenSkill.has(targetFqn)) continue;
        seenSkill.add(targetFqn);
        insertSkillDep.run(skill.fqn, targetFqn);
      }
      const seenMcp = new Set<string>();
      for (const targetFqn of deps.mcps) {
        if (seenMcp.has(targetFqn)) continue;
        seenMcp.add(targetFqn);
        insertMcpDep.run(skill.fqn, targetFqn);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async findByFqn(fqn: string): Promise<Skill | null> {
    const row = this.db
      .prepare(
        "SELECT origin, description, version, prereqs, prereqs_ack, installed_at, updated_at FROM skills WHERE fqn = ?",
      )
      .get(fqn) as SkillRow | undefined;
    if (row === undefined) return null;
    const deps = await this.listDependencies(fqn);
    return rowToSkill(fqn, row, deps);
  }

  async findByOrigin(origin: string): Promise<Skill | null> {
    const row = this.db
      .prepare(
        "SELECT fqn, description, version, prereqs, prereqs_ack, installed_at, updated_at FROM skills WHERE origin = ? LIMIT 1",
      )
      .get(origin) as (SkillRow & { fqn: string }) | undefined;
    if (row === undefined) return null;
    const deps = await this.listDependencies(row.fqn);
    return Skill.fromStored({
      fqn: row.fqn,
      origin,
      description: row.description,
      version: row.version,
      prereqs: row.prereqs ?? undefined,
      dependencies: deps,
      prereqsAck: row.prereqs_ack !== 0,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    });
  }

  async findAll(): Promise<Skill[]> {
    const rows = this.db
      .prepare(
        "SELECT fqn, origin, description, version, prereqs, prereqs_ack, installed_at, updated_at FROM skills ORDER BY fqn",
      )
      .all() as unknown as (SkillRow & { fqn: string; origin: string })[];
    const depsByFqn = this.loadAllDeps();
    const out: Skill[] = [];
    for (const row of rows) {
      try {
        const deps = depsByFqn.get(row.fqn) ?? { skills: [], mcps: [] };
        out.push(
          Skill.fromStored({
            fqn: row.fqn,
            origin: row.origin,
            description: row.description,
            version: row.version,
            prereqs: row.prereqs ?? undefined,
            dependencies: deps,
            prereqsAck: row.prereqs_ack !== 0,
            installedAt: row.installed_at,
            updatedAt: row.updated_at,
          }),
        );
      } catch (cause) {
        this.logger.warn(
          { fqn: row.fqn ?? null, cause: (cause as Error).message },
          "catalog/skill: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  async delete(fqn: string): Promise<void> {
    this.db.prepare("DELETE FROM skills WHERE fqn = ?").run(fqn);
  }

  async *streamFiles(fqn: string): AsyncIterable<SkillFile> {
    const rows = this.db
      .prepare("SELECT rel_path, content FROM skill_files WHERE skill_fqn = ?")
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
      .prepare("SELECT content FROM skill_files WHERE skill_fqn = ? AND rel_path = 'SKILL.md'")
      .get(fqn) as { content: Uint8Array } | undefined;
    if (row === undefined) throw new SkillNotFoundError(fqn);
    const buf = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    return buf.toString("utf8");
  }

  async listDependencies(fqn: string): Promise<SkillDependencies> {
    const skillRows = this.db
      .prepare(
        "SELECT target_fqn FROM skill_skill_dependencies WHERE source_fqn = ? ORDER BY target_fqn",
      )
      .all(fqn) as unknown as { target_fqn: string }[];
    const mcpRows = this.db
      .prepare(
        "SELECT target_fqn FROM skill_mcp_dependencies WHERE source_fqn = ? ORDER BY target_fqn",
      )
      .all(fqn) as unknown as { target_fqn: string }[];
    return {
      skills: skillRows.map((r) => ({ fqn: r.target_fqn })),
      mcps: mcpRows.map((r) => ({ fqn: r.target_fqn })),
    };
  }

  async findDependentAgents(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT source_fqn FROM agent_skill_dependencies WHERE target_fqn = ? ORDER BY source_fqn",
      )
      .all(targetFqn) as unknown as { source_fqn: string }[];
    return rows.map((r) => r.source_fqn);
  }

  async findDependentSkills(targetFqn: string): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT source_fqn FROM skill_skill_dependencies WHERE target_fqn = ? ORDER BY source_fqn",
      )
      .all(targetFqn) as unknown as { source_fqn: string }[];
    return rows.map((r) => r.source_fqn);
  }

  async setFlags(fqn: string, flags: { prereqsAck?: boolean }): Promise<void> {
    if (flags.prereqsAck === undefined) return;
    this.db
      .prepare("UPDATE skills SET prereqs_ack = ?, updated_at = ? WHERE fqn = ?")
      .run(flags.prereqsAck ? 1 : 0, new Date().toISOString(), fqn);
  }

  private loadAllDeps(): Map<string, SkillDependencies> {
    const out = new Map<string, SkillDependencies>();
    const skillRows = this.db
      .prepare(
        "SELECT source_fqn, target_fqn FROM skill_skill_dependencies ORDER BY source_fqn, target_fqn",
      )
      .all() as unknown as { source_fqn: string; target_fqn: string }[];
    const mcpRows = this.db
      .prepare(
        "SELECT source_fqn, target_fqn FROM skill_mcp_dependencies ORDER BY source_fqn, target_fqn",
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
        .get("catalog_skill") as { version: number } | undefined;
    } catch {
      throw new SchemaMetaNotBootstrappedError("catalog_skill");
    }
    if (existing === undefined) {
      throw new SchemaMetaNotBootstrappedError("catalog_skill");
    }
    if (existing.version !== SKILL_PKG_SCHEMA_VERSION) {
      throw new SchemaMetaMismatchError(
        "catalog_skill",
        existing.version,
        SKILL_PKG_SCHEMA_VERSION,
      );
    }
  }
}

interface SkillRow {
  origin: string;
  description: string;
  version: string;
  prereqs: string | null;
  prereqs_ack: number;
  installed_at: string;
  updated_at: string;
}

function rowToSkill(fqn: string, row: SkillRow, deps: SkillDependencies): Skill {
  return Skill.fromStored({
    fqn,
    origin: row.origin,
    description: row.description,
    version: row.version,
    prereqs: row.prereqs ?? undefined,
    dependencies: deps,
    prereqsAck: row.prereqs_ack !== 0,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  });
}

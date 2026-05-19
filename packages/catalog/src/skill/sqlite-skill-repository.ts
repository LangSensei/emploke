import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { Skill, type SkillDependencies } from "./skill-entity.js";
import type { SkillFile, SkillRepository } from "./skill-repository.js";

const SKILL_PKG_SCHEMA_VERSION = 1;

/**
 * SQLite-backed `SkillRepository`.
 *
 * Schema (two tables, FK cascade on delete):
 *
 *   CREATE TABLE skill (
 *     fqn            TEXT PRIMARY KEY,    -- "<scope>/<shortName>"
 *     origin         TEXT NOT NULL,
 *     scope          TEXT NOT NULL,
 *     short_name     TEXT NOT NULL,
 *     description    TEXT NOT NULL,
 *     version        TEXT NOT NULL,
 *     prereqs        TEXT,
 *     deps_json      TEXT NOT NULL,       -- canonical JSON of SkillDependencies
 *     anchor_content TEXT NOT NULL,       -- SKILL.md bytes
 *     prereqs_ack    INTEGER NOT NULL DEFAULT 1
 *   );
 *   CREATE INDEX skill_origin ON skill(origin);
 *
 *   CREATE TABLE skill_file (
 *     skill_fqn  TEXT NOT NULL REFERENCES skill(fqn) ON DELETE CASCADE,
 *     rel_path   TEXT NOT NULL,
 *     content    BLOB NOT NULL,
 *     PRIMARY KEY (skill_fqn, rel_path)
 *   );
 *
 * Atomicity: `add` runs both tables' inserts inside a single SQLite
 * transaction.
 *
 * The constructor takes an already-opened `DatabaseSync`. The server
 * shares one connection across every per-workspace repository
 * (task / session / catalog / workflow); the file handle count per
 * workspace stays at one. PRAGMAs (journal_mode, synchronous,
 * foreign_keys, ...) are the caller's responsibility — the workspace
 * pkg sets them once on the shared connection.
 *
 * Schema versioning is per-pkg: this repo writes its own row to
 * `schema_meta` keyed by `pkg='catalog_skill'`, sibling to the rows
 * written by `SqliteAgentRepository` (`catalog_agent`) and
 * `SqliteMcpRepository` (`catalog_mcp`).
 */
export class SqliteSkillRepository implements SkillRepository {
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

  async add(skill: Skill, files: ReadonlyMap<string, Buffer>): Promise<void> {
    if (!files.has("SKILL.md")) {
      throw new TypeError(
        `SkillRepository.add requires SKILL.md in the files map (got: ${[...files.keys()].join(", ")})`,
      );
    }
    const upsertSkill = this.db.prepare(
      `INSERT INTO skill (fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fqn) DO UPDATE SET
         origin = excluded.origin,
         scope = excluded.scope,
         short_name = excluded.short_name,
         description = excluded.description,
         version = excluded.version,
         prereqs = excluded.prereqs,
         deps_json = excluded.deps_json,
         anchor_content = excluded.anchor_content,
         prereqs_ack = excluded.prereqs_ack`,
    );
    const deleteFiles = this.db.prepare("DELETE FROM skill_file WHERE skill_fqn = ?");
    const insertFile = this.db.prepare(
      "INSERT INTO skill_file (skill_fqn, rel_path, content) VALUES (?, ?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      upsertSkill.run(
        skill.fqn,
        skill.origin,
        skill.scope,
        skill.shortName,
        skill.description,
        skill.version,
        skill.prereqs ?? null,
        JSON.stringify(skill.dependencies),
        skill.anchorContent,
        skill.prereqsAck ? 1 : 0,
      );
      deleteFiles.run(skill.fqn);
      for (const [relPath, content] of files) {
        insertFile.run(skill.fqn, relPath, content);
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
        "SELECT origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack FROM skill WHERE fqn = ?",
      )
      .get(fqn) as SkillRow | undefined;
    if (row === undefined) return null;
    return rowToSkill(fqn, row);
  }

  async findByOrigin(origin: string): Promise<Skill | null> {
    const row = this.db
      .prepare(
        "SELECT fqn, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack FROM skill WHERE origin = ? LIMIT 1",
      )
      .get(origin) as (SkillRow & { fqn: string }) | undefined;
    if (row === undefined) return null;
    return Skill.fromStored({
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
    });
  }

  async findAll(): Promise<Skill[]> {
    const rows = this.db
      .prepare(
        "SELECT fqn, origin, scope, short_name, description, version, prereqs, deps_json, anchor_content, prereqs_ack FROM skill ORDER BY fqn",
      )
      .all() as unknown as (SkillRow & { fqn: string })[];
    const out: Skill[] = [];
    for (const row of rows) {
      try {
        out.push(
          Skill.fromStored({
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
          }),
        );
      } catch (cause) {
        // Skip rows with FQNs that fail validation. Surface a structured
        // warning so operators can spot a corrupted SQLite catalog
        // without trawling every dashboard list — the row stays in the
        // DB (deletion is a separate operation) and is hidden from
        // listings until the user repairs it.
        this.logger.warn(
          {
            fqn: row.fqn ?? null,
            cause: (cause as Error).message,
          },
          "catalog/skill: skipping row that failed validation",
        );
      }
    }
    return out;
  }

  async delete(fqn: string): Promise<void> {
    this.db.prepare("DELETE FROM skill WHERE fqn = ?").run(fqn);
  }

  async *streamFiles(fqn: string): AsyncIterable<SkillFile> {
    const rows = this.db
      .prepare("SELECT rel_path, content FROM skill_file WHERE skill_fqn = ?")
      .all(fqn) as { rel_path: string; content: Uint8Array }[];
    for (const row of rows) {
      yield {
        relPath: row.rel_path,
        content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
      };
    }
  }

  async setFlags(fqn: string, flags: { prereqsAck?: boolean }): Promise<void> {
    if (flags.prereqsAck === undefined) return;
    this.db
      .prepare("UPDATE skill SET prereqs_ack = ? WHERE fqn = ?")
      .run(flags.prereqsAck ? 1 : 0, fqn);
  }

  // ─── schema management ──────────────────────────────────────

  private ensureSchema(): void {
    // Post-issue-#123: the MigrationCoordinator owns DDL. This
    // repository's job is to assert the post-condition — a
    // `schema_meta` row for the `catalog_skill` pkg at the expected
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
        .get("catalog_skill") as { version: number } | undefined;
    } catch {
      // `schema_meta` itself missing → coordinator never ran.
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
  scope: string;
  short_name: string;
  description: string;
  version: string;
  prereqs: string | null;
  deps_json: string;
  anchor_content: string;
  prereqs_ack: number;
}

function rowToSkill(fqn: string, row: SkillRow): Skill {
  return Skill.fromStored({
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
  });
}

function parseDeps(json: string): SkillDependencies {
  try {
    const parsed = JSON.parse(json) as Partial<SkillDependencies>;
    return {
      skills: parsed.skills ?? [],
      mcps: parsed.mcps ?? [],
    };
  } catch {
    return { skills: [], mcps: [] };
  }
}

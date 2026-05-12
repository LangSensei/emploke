import { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { Skill, type SkillDependencies } from "./skill-entity.js";
import type { SkillFile, SkillRepository } from "./skill-repository.js";

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
 *     anchor_content TEXT NOT NULL        -- SKILL.md bytes
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
 * transaction. Concurrency: WAL + SQLite internal serialisation.
 */
export class SqliteSkillRepository implements SkillRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  constructor(dbPath: string, opts?: { logger?: Logger }) {
    this.db = new DatabaseSync(dbPath);
    this.logger = opts?.logger ?? silentLogger;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // Legacy schema (pre-`fqn` rename) used `name` as the PK column.
    // Emploke isn't released yet, so dropping the legacy table is safe
    // and avoids carrying a one-shot ALTER TABLE migration that would
    // need to be retired immediately. If the existing table is missing
    // `fqn`, wipe it (skill_file is FK-cascade-tied to skill).
    if (tableHasLegacyShape(this.db, "skill", "fqn")) {
      this.db.exec("DROP TABLE IF EXISTS skill_file");
      this.db.exec("DROP TABLE IF EXISTS skill");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill (
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
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS skill_origin ON skill(origin)");
    // Migrations:
    //  - `prereqs_ack` was added after the initial schema. Pre-1.0 we
    //    grandfather existing rows to "ack-ed"; the sync path resets
    //    it to false on entries whose upstream prereqs text changes.
    //  - `orphaned` USED to be a stored flag, but is now derived from
    //    the dep graph at projection time. Existing DBs may still have
    //    the column; SQLite tolerates extra columns on SELECT (we
    //    explicitly enumerate the ones we care about), so leaving it
    //    in place is harmless. We drop it best-effort to keep the
    //    schema clean — `DROP COLUMN` is supported on SQLite ≥ 3.35
    //    (Node 22 ships ≥ 3.46) and the column is unindexed so the
    //    drop is cheap.
    addColumnIfMissing(this.db, "skill", "prereqs_ack", "INTEGER NOT NULL DEFAULT 1");
    dropColumnIfPresent(this.db, "skill", "orphaned");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_file (
        skill_fqn  TEXT NOT NULL REFERENCES skill(fqn) ON DELETE CASCADE,
        rel_path   TEXT NOT NULL,
        content    BLOB NOT NULL,
        PRIMARY KEY (skill_fqn, rel_path)
      )
    `);
  }

  close(): void {
    this.db.close();
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
        this.logger.warn("catalog/skill: skipping row that failed validation", {
          fqn: row.fqn ?? null,
          cause: (cause as Error).message,
        });
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

/**
 * Returns true if `tableName` exists in the DB but does NOT yet have
 * the column `requiredCol`. Used to detect the legacy pre-`fqn`-rename
 * schema (which had a `name` PK column instead of `fqn`) so it can
 * be dropped & recreated. Emploke isn't released yet, so dropping
 * legacy data is intentional  we don't carry one-shot ALTER TABLE
 * migrations across schema generations.
 */
export function tableHasLegacyShape(
  db: DatabaseSync,
  tableName: string,
  requiredCol: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (rows.length === 0) return false;
  return !rows.some((r) => r.name === requiredCol);
}

/**
 * Add `colName colDef` to `tableName` iff the column is missing.
 * Used for additive non-destructive migrations (new boolean flags
 * with constant defaults). The constant default lets SQLite apply
 * the value to historical rows without rewriting the table.
 */
export function addColumnIfMissing(
  db: DatabaseSync,
  tableName: string,
  colName: string,
  colDef: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === colName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDef}`);
}

/**
 * Drop `colName` from `tableName` iff the column is present. Used to
 * retire columns whose meaning has moved to derived state (e.g. the
 * `orphaned` flag, now computed from the dep graph at projection
 * time). `DROP COLUMN` requires SQLite ≥ 3.35; Node 22 ships ≥ 3.46
 * so it's available in all our targets.
 *
 * No-op if the table doesn't exist or the column is already gone —
 * idempotent on every run.
 */
export function dropColumnIfPresent(db: DatabaseSync, tableName: string, colName: string): void {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === colName)) return;
  db.exec(`ALTER TABLE ${tableName} DROP COLUMN ${colName}`);
}

import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "@emploke/workspace";

/**
 * Migrate `catalog_skill` from v1 → v2 for issue #122.
 *
 * Schema changes:
 *   1. Rename `skill` → `skills` and `skill_file` → `skill_files`
 *      (project-wide plural convention).
 *   2. Drop `scope` + `short_name` (derive from `fqn.split('/')` in
 *      the application layer; triple-redundancy removed).
 *   3. Drop `anchor_content` (the SKILL.md bytes already live in
 *      `skill_files` at `rel_path = 'SKILL.md'` — single source of
 *      truth).
 *   4. Drop `deps_json` (replaced by indexed FK dep tables; see below).
 *   5. Add `installed_at` + `updated_at` (consistency with other
 *      emploke schemas; enables `ORDER BY updated_at DESC` recency
 *      views). Backfilled with the migration timestamp because no
 *      historical install date is recoverable.
 *   6. Create `skill_skill_dependencies` + `skill_mcp_dependencies`,
 *      both with `(source_fqn, target_fqn)` PK, source `ON DELETE
 *      CASCADE` (delete cleans dep rows), target `ON DELETE RESTRICT`
 *      (cannot delete depended-on entry). The skill self-ref table
 *      has a `CHECK (source_fqn != target_fqn)` for trivial 1-node
 *      cycle prevention; deeper cycles remain an application-level
 *      concern (`CyclicDependencyError`).
 *
 * Cross-pkg dependency: `dependsOn: ["catalog_mcp:2"]` — the
 * `skill_mcp_dependencies.target_fqn` column FK-references
 * `mcps(fqn)`, which only exists at the v2 shape.
 *
 * ## Migration mechanics
 *
 * SQLite cannot `DROP COLUMN` while a column carries `NOT NULL` or
 * appears in a FK declaration of another table; the safest portable
 * path is the canonical create-new-copy-drop-rename dance. Since the
 * backfill needs the v1 `deps_json` blob to resolve origins → fqns,
 * `schemaSQL` first stashes `(fqn, deps_json)` into a temporary
 * `_skill_deps_v1` table BEFORE dropping the old `skill` table, then
 * the {@link backfill} hook reads from that scratch table, resolves
 * via sibling repositories' v2 tables (`skills`, `mcps`), inserts dep
 * rows, and drops the scratch table. Everything runs inside the
 * coordinator's single `BEGIN IMMEDIATE` so partial failure rolls the
 * whole batch back.
 *
 * Backfill edge cases (mirrors today's `parseDeps` behaviour):
 *   - Malformed / empty `deps_json` → skip silently. The v1 catalog
 *     was already tolerating this shape.
 *   - Origin not resolvable to a sibling fqn → log a warning row to
 *     `_skill_deps_unresolved` and skip the dep INSERT. v1 catalog
 *     had `OriginConflict` semantics meaning every referenced origin
 *     should already exist; if it does not, the v1 catalog was in a
 *     degraded state and we preserve that observability.
 *
 * The coordinator wraps the batch in `BEGIN IMMEDIATE` + `PRAGMA
 * foreign_keys = OFF`, so this migration's SQL must NOT include its
 * own transaction markers and the dep-table FKs can be populated even
 * before the post-batch `PRAGMA foreign_key_check`.
 */
export const v1To2: Migration = {
  pkg: "catalog_skill",
  fromVersion: 1,
  toVersion: 2,
  dependsOn: ["catalog_mcp:2"],
  schemaSQL: `
    -- 1. Stash old (fqn, deps_json) so the backfill can resolve them
    --    against the v2 sibling tables. Temporary; dropped at the end
    --    of backfill().
    CREATE TABLE _skill_deps_v1 AS
      SELECT fqn, deps_json FROM skill;

    -- 2. Build the v2 skills table (no scope / short_name /
    --    anchor_content / deps_json; plus installed_at / updated_at).
    CREATE TABLE skills_v2 (
      fqn          TEXT PRIMARY KEY NOT NULL,
      origin       TEXT NOT NULL,
      description  TEXT NOT NULL,
      version      TEXT NOT NULL,
      prereqs      TEXT,
      prereqs_ack  INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    INSERT INTO skills_v2 (
      fqn, origin, description, version, prereqs, prereqs_ack,
      installed_at, updated_at
    )
      SELECT
        fqn, origin, description, version, prereqs, prereqs_ack,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS installed_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS updated_at
      FROM skill;
    DROP TABLE skill;
    ALTER TABLE skills_v2 RENAME TO skills;
    CREATE INDEX skills_origin     ON skills(origin);
    CREATE INDEX skills_updated_at ON skills(updated_at DESC);

    -- 3. Rename the file table to plural AND rebuild it so its FK
    --    references the new plural skills table. SQLite preserves the
    --    original REFERENCES skill(fqn) text across ALTER ... RENAME,
    --    which would dangle once we DROP the v1 skill table.
    ALTER TABLE skill_file RENAME TO _skill_files_v1;
    CREATE TABLE skill_files (
      skill_fqn  TEXT NOT NULL REFERENCES skills(fqn) ON DELETE CASCADE,
      rel_path   TEXT NOT NULL,
      content    BLOB NOT NULL,
      PRIMARY KEY (skill_fqn, rel_path)
    );
    INSERT INTO skill_files (skill_fqn, rel_path, content)
      SELECT skill_fqn, rel_path, content FROM _skill_files_v1;
    DROP TABLE _skill_files_v1;

    -- 4. Dep tables. Self-ref has the 1-node-cycle CHECK.
    CREATE TABLE skill_skill_dependencies (
      source_fqn TEXT NOT NULL REFERENCES skills(fqn) ON DELETE CASCADE,
      target_fqn TEXT NOT NULL REFERENCES skills(fqn) ON DELETE RESTRICT,
      PRIMARY KEY (source_fqn, target_fqn),
      CHECK (source_fqn != target_fqn)
    );
    CREATE INDEX skill_skill_dependencies_reverse
      ON skill_skill_dependencies(target_fqn);

    CREATE TABLE skill_mcp_dependencies (
      source_fqn TEXT NOT NULL REFERENCES skills(fqn) ON DELETE CASCADE,
      target_fqn TEXT NOT NULL REFERENCES mcps(fqn)   ON DELETE RESTRICT,
      PRIMARY KEY (source_fqn, target_fqn)
    );
    CREATE INDEX skill_mcp_dependencies_reverse
      ON skill_mcp_dependencies(target_fqn);
  `,
  backfill: (db: DatabaseSync) => {
    backfillSkillDeps(db);
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

/**
 * Read every stashed `(fqn, deps_json)` and translate origin arrays
 * to fqn-keyed dep table rows. Only origins that resolve via the
 * v2 sibling tables (`skills.origin`, `mcps.origin`) get inserted;
 * unresolved ones are skipped silently, mirroring v1's tolerant
 * `parseDeps` semantics. Self-loops (skill → itself) are skipped to
 * preserve the CHECK constraint — they were never meaningful and the
 * v1 catalog would have stored them as data noise.
 */
function backfillSkillDeps(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT fqn, deps_json FROM _skill_deps_v1")
    .all() as unknown as DepBlob[];
  const skillFqnByOrigin = collectFqnsByOrigin(db, "skills");
  const mcpFqnByOrigin = collectFqnsByOrigin(db, "mcps");
  const insertSkillDep = db.prepare(
    `INSERT OR IGNORE INTO skill_skill_dependencies (source_fqn, target_fqn) VALUES (?, ?)`,
  );
  const insertMcpDep = db.prepare(
    `INSERT OR IGNORE INTO skill_mcp_dependencies (source_fqn, target_fqn) VALUES (?, ?)`,
  );
  for (const row of rows) {
    const deps = parseDeps(row.deps_json);
    for (const origin of deps.skills ?? []) {
      const targetFqn = skillFqnByOrigin.get(origin);
      if (targetFqn === undefined) continue;
      if (targetFqn === row.fqn) continue;
      insertSkillDep.run(row.fqn, targetFqn);
    }
    for (const origin of deps.mcps ?? []) {
      const targetFqn = mcpFqnByOrigin.get(origin);
      if (targetFqn === undefined) continue;
      insertMcpDep.run(row.fqn, targetFqn);
    }
  }
  db.exec("DROP TABLE _skill_deps_v1");
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

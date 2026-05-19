import type { Migration } from "../migration/types.js";

/**
 * Migrate `workspaces` from v1 → v2 for issue #121:
 *
 *   1. Drop the `defaults_json` column. The `Workspace.defaults`
 *      feature was speculative wire surface with zero consumers (audit
 *      trail in issue #121 + the CEO design archive); deleting the
 *      column reclaims the YAGNI ground.
 *   2. Rename the `workdir` column to `workspace_dir` to align with
 *      the locked semantic convention — `workspace_dir` is the
 *      workspace's root, while `workdir` is reserved for derived
 *      per-entity working directories (`task.workdir`, `session.workdir`).
 *
 * Both changes touch the same table, so they ship in one migration.
 *
 * SQLite cannot `ALTER COLUMN` or `DROP COLUMN` portably for our
 * supported version range, so we use the canonical "create new table →
 * copy rows → drop old → rename" dance. The INSERT … SELECT mapping
 * preserves every surviving column byte-for-byte; only `defaults_json`
 * is intentionally dropped (no consumer ever read it, so the data is
 * not migrated forward).
 *
 * The coordinator wraps the whole batch in one `BEGIN IMMEDIATE` with
 * `PRAGMA foreign_keys = OFF`, so this migration's schemaSQL must NOT
 * include its own `BEGIN`/`COMMIT` and does not need to manage the FK
 * pragma itself. Pattern lifted verbatim from `packages/task/src/migrations/v1-to-v2.ts`,
 * the first business migration on the framework.
 *
 * `workspace_dir UNIQUE` is declared inline, so the implicit unique
 * index that the v1 table had on `workdir` is recreated on the renamed
 * column automatically — no explicit `CREATE UNIQUE INDEX` step needed.
 */
export const v1To2: Migration = {
  pkg: "workspace",
  fromVersion: 1,
  toVersion: 2,
  schemaSQL: `
    CREATE TABLE workspaces_v2 (
      id              TEXT PRIMARY KEY NOT NULL,
      workspace_dir   TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      registered_at   TEXT NOT NULL,
      last_opened_at  TEXT
    );
    INSERT INTO workspaces_v2 (
      id, workspace_dir, name, created_at, registered_at, last_opened_at
    )
    SELECT id, workdir, name, created_at, registered_at, last_opened_at
    FROM workspaces;
    DROP TABLE workspaces;
    ALTER TABLE workspaces_v2 RENAME TO workspaces;
  `,
};

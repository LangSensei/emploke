import type { Migration } from "@emploke/workspace";

/**
 * Initial schema for the `task` pkg's slice of
 * `<workspace>/workspace.db`. This is the **v1** shape from before
 * the `instructions` → `brief`+`details` split (issue #123 / TASK.md
 * "for task it's the v1 schema — historical, but consistent with the
 * framework").
 *
 * A fresh DB walks the full chain v0→v1 → v1→v2 → v2→v3, ending at
 * the current production shape. The transient v1 / v2 shapes are
 * dropped or extended by the next migration; no v1 / v2 rows ever
 * touch disk on a fresh install (every step runs inside one
 * coordinator transaction).
 *
 * `IF NOT EXISTS` defends an existing pre-#123 DB where the legacy
 * `ensureSchema()` already created the table at the current shape —
 * such a DB has `schema_meta(task)` ≥ 1 already so this migration is
 * skipped, but the safety margin keeps re-runs idempotent.
 */
export const v0To1: Migration = {
  pkg: "task",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      agent           TEXT NOT NULL,
      runtime         TEXT,
      status          TEXT NOT NULL,
      instructions    TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      started_at      TEXT,
      ended_at        TEXT,
      result_output   TEXT,
      failure_error   TEXT,
      metadata        TEXT NOT NULL DEFAULT '{}'
    );
  `,
};

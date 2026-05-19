import type { Migration } from "@emploke/workspace";

/**
 * Migrate `tasks` from v1 (single `instructions TEXT NOT NULL`
 * column) to v2 (`brief TEXT NOT NULL`, `details TEXT NULL`).
 *
 * SQLite cannot `ALTER COLUMN`, so we use the canonical "create new
 * table → copy rows → drop old → rename" dance.
 *
 * Back-fill rule (preserved verbatim from the pre-#123 inline
 * `migrateV1ToV2`):
 *
 *   - `brief` = first 200 chars of `instructions` (the v2 wire
 *     contract caps brief at 200; v1 had no length cap so longer
 *     values truncate).
 *   - `details` = full `instructions` (no data loss).
 *   - Empty `instructions` rows are coerced to `brief = '(untitled)'`
 *     because v2's entity layer rejects empty brief; the operator
 *     can rename / archive at leisure.
 *
 * The coordinator wraps the whole batch in one `BEGIN IMMEDIATE` so
 * this migration's schemaSQL must NOT include its own BEGIN/COMMIT.
 * The pre-#123 inline `migrateV1ToV2` had `BEGIN;` / `COMMIT;`
 * markers — they are deliberately removed here.
 */
export const v1To2: Migration = {
  pkg: "task",
  fromVersion: 1,
  toVersion: 2,
  schemaSQL: `
    CREATE TABLE tasks_v2 (
      id              TEXT PRIMARY KEY,
      agent           TEXT NOT NULL,
      runtime         TEXT,
      status          TEXT NOT NULL,
      brief           TEXT NOT NULL,
      details         TEXT,
      created_at      TEXT NOT NULL,
      started_at      TEXT,
      ended_at        TEXT,
      result_output   TEXT,
      failure_error   TEXT,
      metadata        TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO tasks_v2 (
      id, agent, runtime, status, brief, details, created_at,
      started_at, ended_at, result_output, failure_error, metadata
    )
    SELECT
      id,
      agent,
      runtime,
      status,
      CASE
        WHEN length(instructions) = 0 THEN '(untitled)'
        ELSE substr(instructions, 1, 200)
      END AS brief,
      instructions AS details,
      created_at,
      started_at,
      ended_at,
      result_output,
      failure_error,
      metadata
    FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_v2 RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS tasks_status_idx     ON tasks(status);
    CREATE INDEX IF NOT EXISTS tasks_runtime_idx    ON tasks(runtime);
    CREATE INDEX IF NOT EXISTS tasks_agent_idx      ON tasks(agent);
    CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at);
  `,
};

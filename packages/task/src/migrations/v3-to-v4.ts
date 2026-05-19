import type { Migration } from "@emploke/workspace";

/**
 * Migrate `tasks` from v3 → v4 for issue #119.
 *
 * Schema changes (table-swap dance — SQLite cannot drop columns with
 * CHECK constraints in-place):
 *
 *   1. Status enum normalised to all-adjective form
 *      (`success`→`succeeded`, `failure`→`failed`, `cancelled` unchanged,
 *      defensive `not_started`→`running` for any pre-FSM row).
 *   2. Five flat failure/cancellation columns collapsed into 3 JSON
 *      columns: `success`, `failure`, `cancellation` (each populated
 *      only when the row is in the matching terminal status).
 *   3. New `origin TEXT NOT NULL DEFAULT 'standalone'` column —
 *      pre-positioned for #118 (workflow-launched tasks will set
 *      `'workflow'`). Existing rows backfill to `'standalone'`.
 *   4. `started_at` tightened to `NOT NULL` (backfilled from
 *      `created_at` for any rare row missing it).
 *   5. Drop legacy `result_output` / `failure_*` / `cancellation_*`
 *      flat columns.
 *   6. New indexes: `idx_tasks_origin`, `idx_tasks_status_origin`,
 *      and the existing per-column indexes are recreated on the new
 *      table with consistent `idx_tasks_*` naming.
 *
 * Read-side conversions during backfill:
 *
 *   - `result_output` → `success.output` (succeeded rows only).
 *   - `failure_kind` + `failure_error` + `failure_exit_code` +
 *     `failure_signal` → `failure` JSON object. Legacy v2 rows with
 *     `failure_kind IS NULL` but `failure_error` populated get
 *     `kind: 'internal'` synthesised — same defaulting the
 *     `reassembleFailure` read path implements today for unmigrated
 *     `failure_error`-only rows.
 *   - `cancellation_kind` + `cancellation_message` → `cancellation`
 *     JSON object. Legacy rows with `cancellation_kind IS NULL`
 *     default to `kind: 'user'`.
 *
 * The coordinator wraps the batch in `BEGIN IMMEDIATE` + `PRAGMA
 * foreign_keys = OFF`, so this migration's SQL must NOT include its
 * own transaction markers.
 *
 * Note on `metadata.exitCode` / `metadata.exitSignal`: these were
 * convention, never schema, so this migration leaves them alone in
 * existing rows' `metadata` JSON blob. The new write path stops
 * setting them — consumers should read `failure.exit_code` /
 * `failure.signal` going forward.
 */
export const v3To4: Migration = {
  pkg: "task",
  fromVersion: 3,
  toVersion: 4,
  schemaSQL: `
    -- 1. Normalise existing status values to v4 adjective form first.
    --    Doing this on the pre-swap table lets the INSERT … SELECT below
    --    just copy the status column verbatim and rely on the v4 CHECK
    --    constraint to validate the result.
    UPDATE tasks SET status = CASE
      WHEN status = 'success'     THEN 'succeeded'
      WHEN status = 'failure'     THEN 'failed'
      WHEN status = 'not_started' THEN 'running'
      ELSE status
    END;

    CREATE TABLE tasks_v4 (
      id            TEXT PRIMARY KEY,
      agent         TEXT NOT NULL,
      runtime       TEXT,
      brief         TEXT NOT NULL,
      details       TEXT,
      origin        TEXT NOT NULL DEFAULT 'standalone',
      status        TEXT NOT NULL
                      CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
      success       TEXT,
      failure       TEXT,
      cancellation  TEXT,
      created_at    TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      metadata      TEXT NOT NULL DEFAULT '{}'
    );

    INSERT INTO tasks_v4 (
      id, agent, runtime, brief, details, origin, status,
      success, failure, cancellation,
      created_at, started_at, ended_at, metadata
    )
    SELECT
      id, agent, runtime, brief, details,
      'standalone' AS origin,
      status,

      CASE WHEN status = 'succeeded' THEN
        json_object('output', COALESCE(result_output, ''))
      ELSE NULL END,

      CASE WHEN status = 'failed' THEN
        json_object(
          'kind',      COALESCE(failure_kind, 'internal'),
          'message',   COALESCE(failure_error, ''),
          'exit_code', CASE WHEN failure_kind = 'exited' THEN failure_exit_code ELSE NULL END,
          'signal',    CASE WHEN failure_kind = 'signal' THEN failure_signal    ELSE NULL END
        )
      ELSE NULL END,

      CASE WHEN status = 'cancelled' THEN
        json_object(
          'kind',    COALESCE(cancellation_kind, 'user'),
          'message', COALESCE(cancellation_message, 'cancelled')
        )
      ELSE NULL END,

      created_at,
      COALESCE(started_at, created_at),
      ended_at,
      metadata
    FROM tasks;

    DROP TABLE tasks;
    ALTER TABLE tasks_v4 RENAME TO tasks;

    CREATE INDEX idx_tasks_origin        ON tasks(origin);
    CREATE INDEX idx_tasks_status        ON tasks(status);
    CREATE INDEX idx_tasks_status_origin ON tasks(status, origin);
    CREATE INDEX idx_tasks_runtime       ON tasks(runtime);
    CREATE INDEX idx_tasks_agent         ON tasks(agent);
    CREATE INDEX idx_tasks_created       ON tasks(created_at DESC);
  `,
};

import type { Migration } from "@emploke/workspace";

/**
 * Initial schema for the `session` pkg's slice of
 * `<workspace>/workspace.db`.
 *
 * Single table: `sessions`. The pkg has no migration history beyond
 * this initial revision (per TASK.md / issue #123 the v0→v1 schema
 * for pkgs without prior migrations carries the current production
 * shape rather than reconstructing a historical chain that never
 * existed).
 *
 * `schema_meta` is created by the framework's
 * {@link MigrationCoordinator} before this migration runs.
 *
 * `IF NOT EXISTS` defends an existing pre-#123 DB that already had
 * the table created by the legacy `ensureSchema()` path — in that
 * case the `schema_meta` row also exists at version 1 so this
 * migration is skipped, but the safety margin keeps re-runs
 * idempotent.
 */
export const v0To1: Migration = {
  pkg: "session",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
    CREATE TABLE IF NOT EXISTS sessions (
      id                  TEXT PRIMARY KEY,
      runtime             TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      runtime_session_id  TEXT,
      last_launch_mode    TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_runtime_idx    ON sessions(runtime);
    CREATE INDEX IF NOT EXISTS sessions_created_at_idx ON sessions(created_at);
  `,
};

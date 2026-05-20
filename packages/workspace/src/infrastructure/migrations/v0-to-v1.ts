import type { Migration } from "../../migration/types.js";

/**
 * Initial schema for the `workspace` pkg's slice of
 * `<EMPLOKE_HOME>/global.db`.
 *
 * The `workspace` pkg owns two tables:
 *
 *   - `workspaces` — one row per registered workspace. Holds id,
 *     workdir, display name, timestamps, and a `defaults_json`
 *     blob for UX defaults (preferred runtime / agent). Both
 *     `defaults_json` and the `workdir` column name are superseded
 *     by the v1→v2 migration (issue #121); the v0→v1 DDL stays
 *     verbatim so existing v1 databases keep migrating into v2
 *     through the canonical chain.
 *   - `global_state` — opaque key/value bag used today only for the
 *     `current_workspace_id` pointer, with room for future
 *     process-wide settings without a schema bump.
 *
 * The framework's `schema_meta` table is created by
 * {@link MigrationCoordinator.run} itself before any per-pkg
 * migration runs, so this DDL does not include it.
 *
 * `IF NOT EXISTS` defends the (unsupported) path of running the
 * migration twice against a partially-initialised DB; the
 * coordinator's version check normally prevents that.
 */
export const v0To1: Migration = {
  pkg: "workspace",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
    CREATE TABLE IF NOT EXISTS workspaces (
      id              TEXT PRIMARY KEY NOT NULL,
      workdir         TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      registered_at   TEXT NOT NULL,
      last_opened_at  TEXT,
      defaults_json   TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS global_state (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `,
};

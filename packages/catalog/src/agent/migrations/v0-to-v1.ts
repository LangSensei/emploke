import type { Migration } from "@emploke/workspace";

/**
 * Initial schema for the `catalog_agent` pkg's slice of
 * `<workspace>/workspace.db`.
 *
 * Tables:
 *   - `agent` — one row per registered agent (FQN PK).
 *   - `agent_file` — per-agent file blobs (ON DELETE CASCADE off
 *     `agent.fqn`).
 *
 * Indexes on `agent.origin` so the dashboard's "show all agents from
 * this origin" filter is indexed.
 *
 * The pkg has no prior migration history; the v0→v1 schema is the
 * current production shape (no historical reconstruction needed —
 * see TASK.md / issue #123).
 */
export const v0To1: Migration = {
  pkg: "catalog_agent",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
    CREATE TABLE IF NOT EXISTS agent (
      fqn              TEXT PRIMARY KEY NOT NULL,
      origin           TEXT NOT NULL,
      scope            TEXT NOT NULL,
      short_name       TEXT NOT NULL,
      description      TEXT NOT NULL,
      version          TEXT NOT NULL,
      prereqs          TEXT,
      deps_json        TEXT NOT NULL,
      anchor_content   TEXT NOT NULL,
      prereqs_ack      INTEGER NOT NULL DEFAULT 1,
      disabled_by_user INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS agent_origin ON agent(origin);
    CREATE TABLE IF NOT EXISTS agent_file (
      agent_fqn  TEXT NOT NULL REFERENCES agent(fqn) ON DELETE CASCADE,
      rel_path   TEXT NOT NULL,
      content    BLOB NOT NULL,
      PRIMARY KEY (agent_fqn, rel_path)
    );
  `,
};

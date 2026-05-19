import type { Migration } from "@emploke/workspace";

/**
 * Initial schema for the `catalog_skill` pkg's slice of
 * `<workspace>/workspace.db`.
 *
 * Tables:
 *   - `skill` — one row per registered skill (FQN PK).
 *   - `skill_file` — per-skill file blobs (ON DELETE CASCADE off
 *     `skill.fqn`).
 *
 * No prior migration history; v0→v1 carries the current production
 * shape.
 */
export const v0To1: Migration = {
  pkg: "catalog_skill",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
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
    );
    CREATE INDEX IF NOT EXISTS skill_origin ON skill(origin);
    CREATE TABLE IF NOT EXISTS skill_file (
      skill_fqn  TEXT NOT NULL REFERENCES skill(fqn) ON DELETE CASCADE,
      rel_path   TEXT NOT NULL,
      content    BLOB NOT NULL,
      PRIMARY KEY (skill_fqn, rel_path)
    );
  `,
};

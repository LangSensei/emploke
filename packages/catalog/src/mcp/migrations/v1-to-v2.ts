import type { Migration } from "@emploke/workspace";

/**
 * Migrate `catalog_mcp` from v1 → v2 for issue #122.
 *
 * Changes:
 *   1. Rename table `mcp` → `mcps` (project-wide plural convention).
 *   2. Rename column `name` → `fqn` (catalog-wide terminology
 *      consistency; the MCP spec's `_meta.name` wire field is
 *      unaffected — only the storage column is renamed).
 *   3. Rename column `content` → `spec` (avoids name collision with
 *      `*_files.content` BLOB on the sibling agent/skill tables; `spec`
 *      is self-documenting and matches the industry "MCP spec" term).
 *   4. Add `CHECK (json_valid(spec))` — DB-level defence, zero cost.
 *   5. Add `installed_at` + `updated_at` for recency-sortable lists,
 *      backfilled with `datetime('now')` (no historical install
 *      timestamp available — acceptable for catalog metadata).
 *   6. Add `mcps_origin` index (v1 oversight — `findByOrigin` existed
 *      without one) and `mcps_updated_at DESC` for recency views.
 *
 * SQLite cannot `RENAME COLUMN` while changing constraints, so we
 * use the table-swap dance. No FK references to the old `mcp` table
 * exist in v1, so no cascade concerns at this step.
 *
 * The coordinator wraps the whole batch in one `BEGIN IMMEDIATE` with
 * `PRAGMA foreign_keys = OFF`, so this migration's `schemaSQL` must
 * NOT include its own `BEGIN`/`COMMIT`.
 *
 * Cross-pkg dependency: this migration must run BEFORE
 * `catalog_skill:v2` and `catalog_agent:v2`, because their new dep
 * tables (`*_mcp_dependencies`) FK-reference the new `mcps(fqn)`
 * column. The dependency direction is encoded on the dependent
 * migrations' `dependsOn`; this file just publishes its own work.
 */
export const v1To2: Migration = {
  pkg: "catalog_mcp",
  fromVersion: 1,
  toVersion: 2,
  schemaSQL: `
    CREATE TABLE mcps_v2 (
      fqn          TEXT PRIMARY KEY NOT NULL,
      origin       TEXT NOT NULL,
      spec         TEXT NOT NULL CHECK (json_valid(spec)),
      installed_at TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    INSERT INTO mcps_v2 (fqn, origin, spec, installed_at, updated_at)
      SELECT
        name AS fqn,
        origin,
        content AS spec,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS installed_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS updated_at
      FROM mcp;
    DROP TABLE mcp;
    ALTER TABLE mcps_v2 RENAME TO mcps;
    CREATE INDEX mcps_origin     ON mcps(origin);
    CREATE INDEX mcps_updated_at ON mcps(updated_at DESC);
  `,
};

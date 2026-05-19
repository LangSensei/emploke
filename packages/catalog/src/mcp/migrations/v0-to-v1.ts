import type { Migration } from "@emploke/workspace";

/**
 * Initial schema for the `catalog_mcp` pkg's slice of
 * `<workspace>/workspace.db`.
 *
 * Single table: `mcp`. No file blobs — MCP specs are single JSON
 * documents stored inline as `content`, not multi-file bundles.
 *
 * No prior migration history; v0→v1 carries the current production
 * shape.
 */
export const v0To1: Migration = {
  pkg: "catalog_mcp",
  fromVersion: 0,
  toVersion: 1,
  schemaSQL: `
    CREATE TABLE IF NOT EXISTS mcp (
      name      TEXT PRIMARY KEY NOT NULL,
      origin    TEXT NOT NULL,
      content   TEXT NOT NULL
    );
  `,
};

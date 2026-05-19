import type { DatabaseSync } from "node:sqlite";
import { runPkgMigrations } from "@emploke/workspace";
import { AGENT_MIGRATIONS } from "../../src/agent/migrations/index.js";
import { MCP_MIGRATIONS } from "../../src/mcp/migrations/index.js";
import { SKILL_MIGRATIONS } from "../../src/skill/migrations/index.js";

/**
 * Async bootstrap helper for catalog tests.
 *
 * Post-issue-#123, the catalog repositories no longer create their
 * tables — the migration coordinator owns DDL. Tests that construct
 * `Sqlite{Agent,Skill,Mcp}Repository` (or `CatalogManager.open`)
 * against a fresh `:memory:` DB must first run this helper so the
 * `schema_meta` rows for `catalog_agent`, `catalog_skill` and
 * `catalog_mcp` are present.
 *
 * As of issue #122 the v1→v2 catalog migrations declare backfill
 * hooks, so the sync variant (`runPkgMigrationsSync`) is no longer
 * usable; tests must `await bootstrapCatalogDb(db)` before
 * constructing any catalog repository.
 */
export async function bootstrapCatalogDb(db: DatabaseSync): Promise<void> {
  await runPkgMigrations(db, [
    { pkg: "catalog_agent", migrations: AGENT_MIGRATIONS },
    { pkg: "catalog_skill", migrations: SKILL_MIGRATIONS },
    { pkg: "catalog_mcp", migrations: MCP_MIGRATIONS },
  ]);
}

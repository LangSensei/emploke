import type { DatabaseSync } from "node:sqlite";
import { runPkgMigrations, runPkgMigrationsSync } from "@emploke/workspace";
import { AGENT_MIGRATIONS } from "../../src/agent/migrations/index.js";
import { MCP_MIGRATIONS } from "../../src/mcp/migrations/index.js";
import { SKILL_MIGRATIONS } from "../../src/skill/migrations/index.js";

/**
 * Sync bootstrap helper for catalog tests.
 *
 * Post-issue-#123, the catalog repositories no longer create their
 * tables — the migration coordinator owns DDL. Tests that construct
 * `Sqlite{Agent,Skill,Mcp}Repository` (or `CatalogManager.open`)
 * against a fresh `:memory:` DB must first run this helper so the
 * `schema_meta` rows for `catalog_agent`, `catalog_skill` and
 * `catalog_mcp` are present.
 *
 * Tests that only need one of the three entities can still call this:
 * the unused migrations are tiny (single-table DDL) and the helper
 * keeps the test setup symmetric with the server's startup flow.
 */
export function bootstrapCatalogDbSync(db: DatabaseSync): void {
  runPkgMigrationsSync(db, [
    { pkg: "catalog_agent", migrations: AGENT_MIGRATIONS },
    { pkg: "catalog_skill", migrations: SKILL_MIGRATIONS },
    { pkg: "catalog_mcp", migrations: MCP_MIGRATIONS },
  ]);
}

/** Async variant of {@link bootstrapCatalogDbSync} for tests that already await. */
export async function bootstrapCatalogDb(db: DatabaseSync): Promise<void> {
  await runPkgMigrations(db, [
    { pkg: "catalog_agent", migrations: AGENT_MIGRATIONS },
    { pkg: "catalog_skill", migrations: SKILL_MIGRATIONS },
    { pkg: "catalog_mcp", migrations: MCP_MIGRATIONS },
  ]);
}

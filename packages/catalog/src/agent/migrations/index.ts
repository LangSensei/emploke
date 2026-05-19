import type { Migration } from "@emploke/workspace";
import { v0To1 } from "./v0-to-v1.js";
import { v1To2 } from "./v1-to-v2.js";

/**
 * Ordered migration chain for the `catalog_agent` pkg. The
 * {@link MigrationCoordinator} (in `@emploke/workspace`) reads this
 * array to compute the pending subset for an open
 * `<workspace>/workspace.db`.
 *
 * History:
 *  - **v0→v1** (initial): `agent` + `agent_file` tables.
 *  - **v1→v2** (issue #122): rename tables to plural; drop
 *    `scope`/`short_name`/`anchor_content`/`deps_json`; add
 *    `installed_at`/`updated_at`; create `agent_skill_dependencies`
 *    + `agent_mcp_dependencies` populated by a backfill that resolves
 *    the old origin URIs to fqns via the v2 sibling tables.
 */
export const AGENT_MIGRATIONS: readonly Migration[] = [v0To1, v1To2];

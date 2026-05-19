import type { Migration } from "@emploke/workspace";
import { v0To1 } from "./v0-to-v1.js";
import { v1To2 } from "./v1-to-v2.js";

/**
 * Ordered migration chain for the `catalog_mcp` pkg. The
 * {@link MigrationCoordinator} (in `@emploke/workspace`) reads this
 * array to compute the pending subset for an open
 * `<workspace>/workspace.db`.
 *
 * History:
 *  - **v0→v1** (initial): `mcp` table.
 *  - **v1→v2** (issue #122): rename table `mcp` → `mcps`; rename
 *    columns `name` → `fqn`, `content` → `spec`; add `installed_at`,
 *    `updated_at`, `CHECK (json_valid(spec))`, and the `mcps_origin`
 *    + `mcps_updated_at` indexes.
 */
export const MCP_MIGRATIONS: readonly Migration[] = [v0To1, v1To2];

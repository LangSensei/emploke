import type { Migration } from "../migration/types.js";
import { v0To1 } from "./v0-to-v1.js";
import { v1To2 } from "./v1-to-v2.js";

/**
 * Ordered migration chain for the `workspace` pkg. The
 * {@link MigrationCoordinator} reads this array to compute the
 * pending subset for an open `<EMPLOKE_HOME>/global.db`.
 *
 * History:
 *  - **v0→v1** (initial): `workspaces` + `global_state` tables.
 *    See `v0-to-v1.ts`.
 *  - **v1→v2** (issue #121): drop `defaults_json` column (zero
 *    consumers); rename `workdir` column → `workspace_dir` to align
 *    with the locked semantic convention. See `v1-to-v2.ts`.
 */
export const WORKSPACE_MIGRATIONS: readonly Migration[] = [v0To1, v1To2];

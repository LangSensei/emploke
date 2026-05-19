import type { Migration } from "../migration/types.js";
import { v0To1 } from "./v0-to-v1.js";

/**
 * Ordered migration chain for the `workspace` pkg. The
 * {@link MigrationCoordinator} reads this array to compute the
 * pending subset for an open `<EMPLOKE_HOME>/global.db`.
 *
 * History:
 *  - **v0→v1** (initial): `workspaces` + `global_state` tables.
 *    See `v0-to-v1.ts`.
 */
export const WORKSPACE_MIGRATIONS: readonly Migration[] = [v0To1];

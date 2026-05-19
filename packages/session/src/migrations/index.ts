import type { Migration } from "@emploke/workspace";
import { v0To1 } from "./v0-to-v1.js";

/**
 * Ordered migration chain for the `session` pkg. The
 * {@link MigrationCoordinator} (in `@emploke/workspace`) reads this
 * array to compute the pending subset for an open
 * `<workspace>/workspace.db`.
 *
 * History:
 *  - **v0→v1** (initial): `sessions` table.
 */
export const SESSION_MIGRATIONS: readonly Migration[] = [v0To1];

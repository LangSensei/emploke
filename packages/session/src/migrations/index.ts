import type { Migration } from "@emploke/workspace";
import { v0To1 } from "./v0-to-v1.js";
import { v1To2 } from "./v1-to-v2.js";

/**
 * Ordered migration chain for the `session` pkg. The
 * {@link MigrationCoordinator} (in `@emploke/workspace`) reads this
 * array to compute the pending subset for an open
 * `<workspace>/workspace.db`.
 *
 * History:
 *  - **v0→v1** (initial): `sessions` table.
 *  - **v1→v2** (issue #120): persist `agent` as a first-class column
 *    (was derived per-call by parsing AGENTS.md), plus
 *    `sessions_agent_idx` for the indexed `WHERE agent = ?` filter
 *    the manager pushes down from `list({agent})`. The migration
 *    itself only does DDL — application-side backfill from
 *    `<sessionsDir>/<id>/AGENTS.md` happens in `SessionManager`
 *    construction because the repository has no `sessionsDir`.
 */
export const SESSION_MIGRATIONS: readonly Migration[] = [v0To1, v1To2];

import type { Migration } from "@emploke/workspace";
import { v0To1 } from "./v0-to-v1.js";
import { v1To2 } from "./v1-to-v2.js";
import { v2To3 } from "./v2-to-v3.js";
import { v3To4 } from "./v3-to-v4.js";

/**
 * Ordered migration chain for the `task` pkg. The
 * {@link MigrationCoordinator} (in `@emploke/workspace`) reads this
 * array to compute the pending subset for an open
 * `<workspace>/workspace.db`.
 *
 * History:
 *  - **v0→v1** (initial): v1 `tasks` table with `instructions` column.
 *  - **v1→v2**: split `instructions` into `brief` (≤200 char wire
 *    contract) + `details` (full text). Refactor pre-1.0 hard cut.
 *  - **v2→v3**: add nullable `failure_*` / `cancellation_*` columns
 *    for ADR-001's typed `TaskFailure` / `TaskCancellation` unions.
 *  - **v3→v4** (issue #119): collapse failure/cancellation columns
 *    into JSON; normalise status enum to adjective form; add
 *    `origin` column; tighten `started_at NOT NULL`.
 *
 * A fresh DB walks all four migrations in sequence, ending at v4.
 * Existing DBs join the chain at whatever version their `schema_meta`
 * row declares.
 */
export const TASK_MIGRATIONS: readonly Migration[] = [v0To1, v1To2, v2To3, v3To4];

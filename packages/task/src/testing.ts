/**
 * Test-only entry point. The `TaskRepository` is now backed by SQLite
 * in production; for tests, construct a `SqliteTaskRepository` with the
 * `":memory:"` path to get an isolated in-memory database that lives
 * only for the lifetime of the connection.
 *
 * Post-issue-#123: the repository no longer bootstraps tables itself.
 * Tests must call `bootstrapTaskDb(db)` first to run the coordinator
 * with `TASK_MIGRATIONS`.
 *
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * import { bootstrapTaskDb, SqliteTaskRepository } from "@emploke/task/testing";
 *
 * const db = new DatabaseSync(":memory:");
 * await bootstrapTaskDb(db);
 * const repo = new SqliteTaskRepository({ db });
 * ```
 *
 * Tests are encouraged to call `repo.close()` in cleanup.
 */

import type { DatabaseSync } from "node:sqlite";
import { runPkgMigrations } from "@emploke/workspace";
import { TASK_MIGRATIONS } from "./migrations/index.js";

export { SqliteTaskRepository } from "./repositories/sqlite-task-repository.js";

/**
 * Run the migration coordinator against a fresh `workspace.db` (or
 * `:memory:` test DB) so the `SqliteTaskRepository` constructor sees
 * the `schema_meta` row it now requires. Idempotent.
 */
export async function bootstrapTaskDb(db: DatabaseSync): Promise<void> {
  await runPkgMigrations(db, [{ pkg: "task", migrations: TASK_MIGRATIONS }]);
}

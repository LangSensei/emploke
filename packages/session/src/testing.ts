/**
 * Test-only entry point. The `SessionRepository` is now backed by
 * SQLite in production; for tests, construct a `SqliteSessionRepository`
 * with a `new DatabaseSync(":memory:")` connection to get an isolated
 * in-memory database that lives only for the lifetime of the connection.
 *
 * Post-issue-#123: the repository no longer bootstraps tables itself.
 * Tests must call `bootstrapSessionDb(db)` first to run the coordinator
 * with `SESSION_MIGRATIONS`.
 *
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * import { bootstrapSessionDb, SqliteSessionRepository } from "@emploke/session/testing";
 *
 * const db = new DatabaseSync(":memory:");
 * await bootstrapSessionDb(db);
 * const repo = new SqliteSessionRepository({ db });
 * await repo.save("20260101-aaaaaaaa", { runtime: "copilot", ... });
 * ```
 */

import type { DatabaseSync } from "node:sqlite";
import { runPkgMigrations } from "@emploke/workspace";
import { SESSION_MIGRATIONS } from "./migrations/index.js";

export { SqliteSessionRepository } from "./repositories/sqlite-session-repository.js";

/**
 * Run the migration coordinator against a fresh `workspace.db` (or
 * `:memory:` test DB) so the `SqliteSessionRepository` constructor
 * sees the `schema_meta` row it now requires. Idempotent.
 */
export async function bootstrapSessionDb(db: DatabaseSync): Promise<void> {
  await runPkgMigrations(db, [{ pkg: "session", migrations: SESSION_MIGRATIONS }]);
}

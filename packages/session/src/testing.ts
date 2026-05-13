/**
 * Test-only entry point. The `SessionRepository` is now backed by
 * SQLite in production; for tests, construct a `SqliteSessionRepository`
 * with a `new DatabaseSync(":memory:")` connection to get an isolated
 * in-memory database that lives only for the lifetime of the connection.
 *
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * import { SqliteSessionRepository } from "@emploke/session/testing";
 *
 * const db = new DatabaseSync(":memory:");
 * const repo = new SqliteSessionRepository({ db });
 * await repo.save("20260101-aaaaaaaa", { runtime: "copilot", ... });
 * // Tests own `db.close()` in cleanup — `repo.close()` is a no-op
 * // because the connection is owned by the caller.
 * ```
 */

export { SqliteSessionRepository } from "./repositories/sqlite-session-repository.js";

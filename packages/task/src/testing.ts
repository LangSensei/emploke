/**
 * Test-only entry point. The `TaskRepository` is now backed by SQLite
 * in production; for tests, construct a `SqliteTaskRepository` with the
 * `":memory:"` path to get an isolated in-memory database that lives
 * only for the lifetime of the connection.
 *
 * ```ts
 * import { SqliteTaskRepository } from "@emploke/task/testing";
 *
 * const repo = new SqliteTaskRepository(":memory:");
 * await repo.save({ id: "20260101-aaaaaaaa", ... });
 * ```
 *
 * Tests are encouraged to call `repo.close()` in cleanup.
 */

export { SqliteTaskRepository } from "./repositories/sqlite-task-repository.js";

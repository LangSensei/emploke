/**
 * Test-only entry point. The `SessionRepository` is now backed by
 * SQLite in production; for tests, construct a `SqliteSessionRepository`
 * with the `":memory:"` path to get an isolated in-memory database
 * that lives only for the lifetime of the connection.
 *
 * ```ts
 * import { SqliteSessionRepository } from "@emploke/session/testing";
 *
 * const repo = new SqliteSessionRepository(":memory:");
 * await repo.save("20260101-aaaaaaaa", { runtime: "copilot", ... });
 * ```
 *
 * Tests are encouraged to call `repo.close()` in cleanup; for in-memory
 * databases it's a no-op-ish (the connection releases on GC anyway),
 * but for file-backed test fixtures it ensures the WAL sidecar releases
 * on Windows so the temp dir can be removed.
 */

export { SqliteSessionRepository } from "./repositories/sqlite-session-repository.js";

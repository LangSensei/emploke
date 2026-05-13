/**
 * Test-only entry point. The `WorkspaceRepository` is now backed by
 * SQLite in production; for tests, construct a `SqliteWorkspaceRepository`
 * with a `":memory:"` `DatabaseSync` to get an isolated in-memory
 * database that lives only for the lifetime of the connection.
 *
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * import { SqliteWorkspaceRepository } from "@emploke/workspace/testing";
 *
 * const db = new DatabaseSync(":memory:");
 * const repo = new SqliteWorkspaceRepository({ db });
 * // ... run test ...
 * db.close();
 * ```
 *
 * Tests are encouraged to call `db.close()` in cleanup; for in-memory
 * databases it's nearly a no-op (the connection releases on GC anyway),
 * but for any file-backed test fixture it ensures the journal sidecar
 * releases on Windows so the temp dir can be removed.
 */

export { SqliteWorkspaceRepository } from "./repositories/sqlite-workspace-repository.js";

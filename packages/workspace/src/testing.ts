/**
 * Test-only entry point. The `WorkspaceRepository` is now backed by
 * SQLite in production; for tests, construct a `SqliteWorkspaceRepository`
 * with a `":memory:"` `DatabaseSync` to get an isolated in-memory
 * database that lives only for the lifetime of the connection.
 *
 * Post-issue-#123: the repository no longer bootstraps tables itself.
 * Tests must call `bootstrapWorkspaceRegistryDb(db)` first to run the
 * coordinator with `WORKSPACE_MIGRATIONS`.
 *
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * import {
 *   bootstrapWorkspaceRegistryDb,
 *   SqliteWorkspaceRepository,
 * } from "@emploke/workspace/testing";
 *
 * const db = new DatabaseSync(":memory:");
 * await bootstrapWorkspaceRegistryDb(db);
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

import type { DatabaseSync } from "node:sqlite";
import { runPkgMigrations } from "./migration/index.js";
import { WORKSPACE_MIGRATIONS } from "./migrations/index.js";

export { SqliteWorkspaceRepository } from "./repositories/sqlite-workspace-repository.js";

/**
 * Run the migration coordinator against a fresh `<EMPLOKE_HOME>/global.db`
 * (or `:memory:` test DB) so the `SqliteWorkspaceRepository` constructor
 * sees the `schema_meta` row it now requires. Idempotent.
 */
export async function bootstrapWorkspaceRegistryDb(db: DatabaseSync): Promise<void> {
  await runPkgMigrations(db, [{ pkg: "workspace", migrations: WORKSPACE_MIGRATIONS }]);
}

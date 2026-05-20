/**
 * Test-only entry point.
 *
 * Tests need direct access to a few things that the public API
 * (`@emploke/workspace`) hides per naming-conventions §5:
 *
 *   - `SqliteWorkspaceRepository` / `SqliteWorkspaceQueries` so domain
 *     test cases can populate / drain rows without going through the
 *     mediator. The production path resolves these via DI and tests
 *     that do the same may import this entry to construct directly.
 *   - `bootstrapWorkspaceRegistryDb(db)` — runs the migration
 *     coordinator with `WORKSPACE_MIGRATIONS`. Post-issue-#123 the
 *     repository asserts the `schema_meta` row exists, so tests must
 *     bootstrap first.
 *   - `Workspace` aggregate + value objects so DDD-layer tests can
 *     construct + drain events on the aggregate directly.
 *
 * Example:
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
 * const repo = new SqliteWorkspaceRepository(db);
 * // ... run test ...
 * db.close();
 * ```
 *
 * For in-memory DBs `db.close()` is nearly a no-op (the connection
 * releases on GC anyway), but file-backed fixtures should close
 * explicitly so the journal sidecar releases on Windows.
 */

import type { DatabaseSync } from "node:sqlite";
import { WORKSPACE_MIGRATIONS } from "./infrastructure/migrations/index.js";
import { runPkgMigrations } from "./migration/index.js";

export { RegisterWorkspaceCommandHandler } from "./application/commands/register-workspace/register-workspace.command-handler.js";
export { RenameWorkspaceCommandHandler } from "./application/commands/rename-workspace/rename-workspace.command-handler.js";
export { SetCurrentWorkspaceCommandHandler } from "./application/commands/set-current-workspace/set-current-workspace.command-handler.js";
export { UnregisterWorkspaceCommandHandler } from "./application/commands/unregister-workspace/unregister-workspace.command-handler.js";
export { Clock } from "./domain/clock.js";
export { WorkspaceRegistered } from "./domain/events/workspace-registered.js";
export { WorkspaceRenamed } from "./domain/events/workspace-renamed.js";
export { WorkspaceUnregistered } from "./domain/events/workspace-unregistered.js";
export { WorkspaceDir } from "./domain/value-objects/workspace-dir.js";
export { WorkspaceId } from "./domain/value-objects/workspace-id.js";
export { WorkspaceName } from "./domain/value-objects/workspace-name.js";
export { Workspace } from "./domain/workspace.js";
export { WorkspaceRepository } from "./domain/workspace-repository.js";
export { SqliteWorkspaceQueries } from "./infrastructure/sqlite-workspace-queries.js";
export { SqliteWorkspaceRepository } from "./infrastructure/sqlite-workspace-repository.js";
export { SystemClock } from "./infrastructure/system-clock.js";

/**
 * Run the migration coordinator against a fresh
 * `<EMPLOKE_HOME>/global.db` (or `:memory:` test DB) so the
 * repository's constructor sees the `schema_meta` row it now requires.
 * Idempotent.
 */
export async function bootstrapWorkspaceRegistryDb(db: DatabaseSync): Promise<void> {
  await runPkgMigrations(db, [{ pkg: "workspace", migrations: WORKSPACE_MIGRATIONS }]);
}

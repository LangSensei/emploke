/**
 * Thin re-export shim over `@emploke/core`. Kept under the old name
 * `PerWorkspaceContainerCache` for callsite stability inside
 * `@emploke/server`; new code should import from `@emploke/core`
 * directly.
 *
 * Post de-DDD + core extraction: the actual orchestration lives in
 * `@emploke/core`. This module just re-exposes the runtime cache
 * under names the server already uses.
 */

import { type WorkspaceRuntime, WorkspaceRuntimeCache } from "@emploke/core";

export { WorkspaceHasLiveTasksError, type WorkspaceRuntime } from "@emploke/core";

export type PerWorkspaceContainer = WorkspaceRuntime;

/**
 * Alias of `WorkspaceRuntimeCache` from `@emploke/core`. The server
 * still imports under this name for callsite stability.
 *
 * Differences from the old class:
 *   - `invalidate(id)` / `closeAll()` are now async (they close ORMs).
 *   - No `childContainer` on entries (inversify scaffolding removed).
 *   - No `db: DatabaseSync` on entries — each entity pkg owns its own
 *     ORM internally.
 */
export class PerWorkspaceContainerCache extends WorkspaceRuntimeCache {}

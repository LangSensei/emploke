import type { WorkspaceId } from "./value-objects/workspace-id.js";
import type { Workspace } from "./workspace.js";

/**
 * Storage contract for the workspace aggregate.
 *
 * ## Phase 2 / ADR-3 shape
 *
 * Per the ADR-3 unit-of-work pivot, the repository's surface shrinks
 * to the operations that aren't covered by `EntityManager` directly:
 *
 *   - {@link findById} — typed lookup that returns a tracked
 *     aggregate (or `null`). Tracked = subsequent mutations on the
 *     returned instance get picked up by the next `em.flush`.
 *   - {@link delete} — explicit `em.remove` for the aggregate
 *     identified by id (instead of having callers fetch + remove
 *     separately).
 *   - {@link getCurrent} / {@link setCurrent} — read / write the
 *     `global_state.current_workspace_id` row. That table is **not**
 *     a MikroORM entity in Phase 2 (it has no aggregate behaviour;
 *     P1-5 in `.ceo/design/polish-backlog.md` tracks the eventual
 *     move out of workspace pkg entirely), so the repository wraps
 *     raw SQL via `em.execute(...)`.
 *
 * **Notably absent** vs the pre-Phase-2 surface:
 *
 *   - `save()` — gone. `em.flush()` (driven by `TransactionBehavior`)
 *     writes UPDATEs for every tracked entity at the end of every
 *     command pipeline.
 *   - `create()` — gone. Handlers call `em.persist(ws)` directly on
 *     the EntityManager; the flush handles INSERT.
 *   - `list()` — gone. Cross-context list reads are served by
 *     `WorkspaceQueries.list()` (CQRS read side).
 *   - `close()` — gone. The repository no longer owns a `DatabaseSync`
 *     handle; the per-process `MikroORM` instance owns the SQLite
 *     connection and is closed by the bootstrap shutdown hook.
 *
 * Per naming-conventions §3 + §6 — declared as **abstract class** (not
 * TS `interface`) so the same name doubles as the inversify DI token.
 * Implementations live under `infrastructure/`
 * (`MikroWorkspaceRepository` is the production default; tests inject
 * an in-memory subclass or use the MikroORM `:memory:` driver).
 */
export abstract class WorkspaceRepository {
  /**
   * Look up a single workspace by id. Returns `null` when no workspace
   * with that id is registered (404-on-the-wire); throws for storage
   * faults the caller should care about (corrupted index, unreachable
   * fs, etc).
   *
   * The returned aggregate is **tracked** by the EntityManager —
   * subsequent mutations (e.g. `ws.rename(...)`) get written out on
   * the next `em.flush` without any explicit `save()` call.
   */
  abstract findById(id: WorkspaceId): Promise<Workspace | null>;

  /**
   * Remove the workspace's metadata. Idempotent (deleting a missing id
   * is a no-op). Does NOT touch agent-owned content under the
   * workspace's `workspaceDir` (sessions/, tasks/) — that concern
   * lives in the `UnregisterWorkspaceCommandHandler`, not in the
   * repository.
   *
   * If the deleted id was `getCurrent()`, implementations must clear
   * the current selection inside the same transactional unit.
   */
  abstract delete(id: WorkspaceId): Promise<void>;

  /** Id of the most-recently-selected workspace, or `null` when nothing is selected. */
  abstract getCurrent(): Promise<string | null>;

  /**
   * Mark `id` as the current workspace. Throws
   * `WorkspaceNotRegisteredError` when `id` is not registered.
   * Implementations should also bump a `lastOpenedAt` marker if they
   * track recency.
   */
  abstract setCurrent(id: WorkspaceId): Promise<void>;
}

import type { WorkspaceSummaryView } from "./views/workspace-summary-view.js";
import type { WorkspaceView } from "./views/workspace-view.js";

/**
 * Read-side query surface for the workspace pkg.
 *
 * Declared as an **abstract class** (not TS `interface`) so the same
 * name doubles as the inversify DI token. Cross-context consumers
 * (other contexts that need to look up workspace data without holding
 * the aggregate) inject this abstract class via
 * `@inject(WorkspaceQueries)`.
 *
 * Cross-context rule of thumb: this abstract class IS allowed to
 * cross context boundaries (read-only side with no invariant risk).
 * `WorkspaceRepository` is NOT.
 */
export abstract class WorkspaceQueries {
  /** Look up a single workspace by id; `null` when not registered. */
  abstract getById(id: string): Promise<WorkspaceView | null>;

  /**
   * Snapshot of every registered workspace, ordered by `lastOpenedAt`
   * DESC NULLS LAST (most-recently-opened first). Returns `[]` when
   * no workspaces are registered.
   */
  abstract list(): Promise<WorkspaceSummaryView[]>;

  /**
   * Resolve the most-recently-opened workspace (returns its full
   * view). `null` when no workspaces are registered. The "last
   * opened" is what the rest of the system treats as the current
   * workspace from the user's perspective.
   */
  abstract getLastOpened(): Promise<WorkspaceView | null>;

  /**
   * Just the id of the most-recently-opened workspace (or `null`).
   * Faster than `getLastOpened()` when the caller only needs the id
   * (CLI's `workspace current` output, server's `/api/config`
   * payload).
   */
  abstract getLastOpenedId(): Promise<string | null>;
}

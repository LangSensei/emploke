import type { WorkspaceSummaryView } from "./views/workspace-summary-view.js";
import type { WorkspaceView } from "./views/workspace-view.js";

/**
 * Read-side query surface for the workspace pkg.
 *
 * Per naming-conventions §3 + §6 — declared as **abstract class**
 * (not TS `interface`) so the same name doubles as the inversify DI
 * token. Cross-context consumers (other contexts that need to look
 * up workspace data without holding the aggregate) inject this
 * abstract class via `@inject(WorkspaceQueries)`.
 *
 * Cross-context import rules (naming-conventions §8.3): this
 * abstract class IS allowed to cross context boundaries (it's a
 * read-only side with no invariant risk). `WorkspaceRepository` is
 * NOT.
 */
export abstract class WorkspaceQueries {
  /** Look up a single workspace by id; `null` when not registered. */
  abstract getById(id: string): Promise<WorkspaceView | null>;

  /** Snapshot of every registered workspace. Returns `[]` when none. */
  abstract list(): Promise<WorkspaceSummaryView[]>;

  /**
   * Resolve the currently-selected workspace (returns its full view).
   * `null` when no workspace is selected OR the selected id is no
   * longer registered.
   *
   * Reads `global_state.current_workspace_id` — see
   * {@link import("../commands/set-current-workspace.command.js").SetCurrentWorkspaceCommand}
   * for the P1-5 note on why this lives in the workspace pkg in
   * Phase 1.
   */
  abstract getCurrent(): Promise<WorkspaceView | null>;

  /**
   * Just the id of the currently-selected workspace (or null). Faster
   * than `getCurrent()` when the caller only needs the id (CLI's
   * `workspace current` output, server's `/api/config` payload).
   */
  abstract getCurrentId(): Promise<string | null>;
}

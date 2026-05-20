import type { WorkspaceId } from "./value-objects/workspace-id.js";
import type { Workspace } from "./workspace.js";

/**
 * Storage contract for the workspace aggregate.
 *
 * Per naming-conventions §3 + §6 — declared as an **abstract class**
 * (not TS `interface`) so the same name doubles as the inversify DI
 * token. Implementations live under `infrastructure/`
 * (`SqliteWorkspaceRepository` is the production default; tests use
 * the same class against a `":memory:"` `DatabaseSync` — see
 * `@emploke/workspace/testing`).
 *
 * Per-instance scope: one `WorkspaceRepository` covers one emploke root
 * (e.g. `<EMPLOKE_HOME>/global.db`). Workspaces inside that root are
 * addressed by their stable UUID. Multiple roots = multiple repository
 * instances; emploke runs one root per server today.
 *
 * Concurrency: implementations must serialize their internal index
 * mutations across processes (the SQLite implementation uses
 * `BEGIN IMMEDIATE`). Domain-level callers don't have to think about
 * this.
 *
 * "Current workspace": each root remembers the most-recently-selected
 * workspace id as a UX hint for the dashboard's landing page.
 * `getCurrent` / `setCurrent` are part of the persistence surface
 * because the value lives next to the index. (Note: `setCurrent` is
 * itself handled by `SetCurrentWorkspaceCommand` — see the handler for
 * the comment on why it stays here for Phase 1 even though
 * `current_workspace_id` is CLI session state, not workspace domain
 * state. P1-5 in `.ceo/design/polish-backlog.md` tracks the eventual
 * move.)
 */
export abstract class WorkspaceRepository {
  /** Snapshot of every registered workspace under this root. Returns `[]` when none. */
  abstract list(): Promise<Workspace[]>;

  /**
   * Look up a single workspace by id. Returns `null` when no workspace
   * with that id is registered (404-on-the-wire), throws for storage
   * faults the caller should care about (corrupted index, unreachable
   * fs, etc).
   */
  abstract findById(id: WorkspaceId): Promise<Workspace | null>;

  /**
   * Persist mutable fields on an already-registered workspace. Throws
   * `WorkspaceNotRegisteredError` if no row with the given id exists —
   * `save` is **strict update**, never an upsert. Use {@link create}
   * to register a fresh workspace.
   */
  abstract save(workspace: Workspace): Promise<void>;

  /**
   * Atomically register a brand-new workspace, throwing
   * `WorkspaceIdConflictError` if the id is already taken in the
   * index. Distinct from `save` because the create-or-fail semantics
   * have to live inside the same critical section that does the
   * insert — a manager-side `findById` + `save` race-condition check
   * would lose the race against a concurrent `register` with the same id.
   */
  abstract create(workspace: Workspace): Promise<void>;

  /**
   * Remove the workspace's metadata. Idempotent (deleting a missing id
   * is a no-op). Does NOT touch agent-owned content under the
   * workspace's `workspaceDir` (sessions/, tasks/) — that concern
   * lives in the `UnregisterWorkspaceCommandHandler`, not in the
   * repository.
   *
   * If the deleted id was `getCurrent()`, implementations must clear
   * the current selection.
   */
  abstract delete(id: WorkspaceId): Promise<void>;

  /** Id of the most-recently-selected workspace, or `null` when nothing is selected. */
  abstract getCurrent(): Promise<string | null>;

  /**
   * Mark `id` as the current workspace. Throws when `id` is not
   * registered. Implementations should also bump a `lastOpenedAt`
   * marker if they track recency.
   */
  abstract setCurrent(id: WorkspaceId): Promise<void>;

  /**
   * Release any resources the repository acquired (e.g. a `DatabaseSync`
   * file handle). Idempotent — calling `close()` on an already-closed
   * repository is a no-op. After `close()`, every method is allowed
   * to throw.
   *
   * Required because Windows refuses to `unlink` files with open
   * handles. The server's graceful-shutdown path calls this so that
   * tests (and operators on Windows) can remove `global.db` cleanly
   * after the server exits.
   */
  abstract close(): void;
}

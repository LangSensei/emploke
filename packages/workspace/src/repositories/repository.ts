import type { Workspace } from "../workspace-entity.js";

/**
 * Storage contract for workspaces. Implementations decide where the
 * workspace records actually live (a SQLite table is the production
 * default; an HTTP service or in-memory map could be drop-in
 * replacements) — callers never see persistence shape.
 *
 * Per-instance scope: a `WorkspaceRepository` instance covers an
 * **emploke root** (e.g. `~/.emploke/`). Workspaces inside that root
 * are addressed by their stable UUID `id`. Multiple roots = multiple
 * repository instances; emploke runs one root per server today.
 *
 * Concurrency: implementations must serialize their internal index
 * mutations across processes (the FS implementation uses an advisory
 * lock; SQLite uses a transaction). Domain-level callers don't have
 * to think about this.
 *
 * "Current workspace": each root remembers the most-recently-selected
 * workspace id as a UX hint for the dashboard's landing page.
 * `getCurrent` / `setCurrent` are part of the persistence surface
 * because the value lives next to the index.
 */
export interface WorkspaceRepository {
  /** Snapshot of every registered workspace under this root. Returns `[]` when none. */
  list(): Promise<Workspace[]>;

  /**
   * Look up a single workspace by id. Returns `null` when no workspace
   * with that id is registered (404-on-the-wire), throws for storage
   * faults the caller should care about (corrupted index, unreachable
   * fs, etc).
   */
  read(id: string): Promise<Workspace | null>;

  /**
   * Persist mutable fields (`name`, `defaults`) on an already-registered
   * workspace. Throws {@link WorkspaceNotRegisteredError} if no row
   * with the given id exists — `save` is **strict update**, never an
   * upsert. Use {@link create} to register a fresh workspace.
   *
   * Strict-update semantics prevent a subtle resurrect bug: if a
   * concurrent `delete(id)` lands between the manager's `read(id)`
   * and `save(updated)` calls, an upsert would silently re-create
   * the deleted row with the in-flight rename's name and reset
   * timing fields. The strict variant surfaces the race as a typed
   * 404 instead.
   *
   * Atomic from a reader's perspective: concurrent `read` calls see
   * either the previous state or the new one, never partial.
   */
  save(workspace: Workspace): Promise<void>;

  /**
   * Atomically register a brand-new workspace, throwing
   * {@link WorkspaceIdConflictError} if the id is already taken in the
   * index. Distinct from `save` because the create-or-fail semantics
   * have to live inside the same critical section that does the
   * insert — a manager-side `read` + `save` race-condition check would
   * lose the race against a concurrent `init` with the same id.
   *
   * `WorkspaceManager.init` is the canonical caller; it surfaces the
   * conflict to the user. SQLite implementations enforce the guarantee
   * with `INSERT OR FAIL` inside `BEGIN IMMEDIATE`.
   */
  create(workspace: Workspace): Promise<void>;

  /**
   * Remove the workspace's metadata. Idempotent (deleting a missing id
   * is a no-op). Does NOT touch agent-owned content under the
   * workspace's `workdir` (sessions/, tasks/) — that
   * concern lives in `WorkspaceManager.delete(id, { purge })`, not in
   * the repository.
   *
   * If the deleted id was `getCurrent()`, implementations must clear
   * the current selection.
   */
  delete(id: string): Promise<void>;

  /** Id of the most-recently-selected workspace, or `null` when nothing is selected. */
  getCurrent(): Promise<string | null>;

  /**
   * Mark `id` as the current workspace. Throws when `id` is not
   * registered. Implementations should also bump a `lastOpenedAt`
   * marker if they track recency.
   */
  setCurrent(id: string): Promise<void>;

  /**
   * Release any resources the repository acquired (e.g. a `DatabaseSync`
   * file handle). Idempotent — calling `close()` on an already-closed
   * repository is a no-op. After `close()`, every method (`list`,
   * `read`, ...) is allowed to throw; implementations should not be
   * expected to handle reuse.
   *
   * Required because Windows refuses to `unlink` files with open
   * handles. The server's graceful-shutdown path calls this so that
   * tests (and operators on Windows) can remove the `global.db` file
   * cleanly after the server exits. POSIX hosts tolerate
   * unlink-with-open-handles, but explicit close is still good
   * hygiene.
   *
   * In-memory implementations (HTTP-backed, fixture maps) implement
   * this as a no-op.
   */
  close(): void;
}

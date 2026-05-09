import type { Workspace } from "../types.js";

/**
 * Storage contract for workspaces. Implementations decide where the
 * workspace records actually live (a JSON index + per-workspace
 * `workspace.json`, a SQLite table, an HTTP service, ...) — callers
 * never see persistence shape.
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
   * Insert or replace a workspace. Atomic from a reader's perspective:
   * concurrent `read` calls see either the previous state or the new
   * one, never partial. Implementations must register the workspace's
   * id in the root index AND persist its metadata as one logical unit
   * (or do both then unwind on failure).
   *
   * Use {@link create} when the caller's intent is "register a new
   * workspace and surface a typed error if the id is already taken";
   * `save` is upsert (last-writer-wins), which silently overwrites a
   * concurrent same-id init attempt.
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
   * conflict to the user. Repository implementations decide how the
   * "atomic" guarantee is delivered (FS uses the same advisory lock
   * `save` does; SQLite would use `INSERT OR FAIL`).
   */
  create(workspace: Workspace): Promise<void>;

  /**
   * Remove the workspace's metadata. Idempotent (deleting a missing id
   * is a no-op). Does NOT touch agent-owned content under the
   * workspace's `workdir` (sessions/, tasks/, catalog/, etc.) — that
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
}

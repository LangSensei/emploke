import type { Session } from "../session-entity.js";

export { Session } from "../session-entity.js";

/**
 * Filter options for `SessionRepository.list`. v2 (issue #120)
 * promoted `agent` from an FS-derived JS-side post-filter to a
 * persisted column the SQLite repository can evaluate directly via
 * `WHERE agent = ?` on the new `sessions_agent_idx` index.
 */
export interface ListSessionStateOpts {
  /**
   * Drop entries whose `createdAt` is strictly before this ISO 8601
   * timestamp. ISO strings sort lexicographically as dates, so the
   * compare is just `state.createdAt >= opts.createdSince`.
   */
  readonly createdSince?: string;
  /**
   * Filter to sessions whose persisted `agent` (FQN) matches this
   * exact value. v2-only — the column did not exist in v1; before the
   * migration this filter was applied JS-side after an N-way AGENTS.md
   * scan, see `SessionManager.list` history for context.
   */
  readonly agent?: string;
}

/**
 * Storage contract for session state. Implementations decide where the
 * session records actually live (per-session JSON file under a
 * sessions root, a SQL table, ...) — callers never see persistence
 * shape.
 *
 * Per-instance scope: a `SessionRepository` instance covers exactly
 * one workspace's session collection. Multi-workspace deployments
 * instantiate one repository per workspace; the cache layer
 * (`WorkspaceContextCache`) does this implicitly.
 *
 * Concurrency: implementations must guarantee that each *individual*
 * operation here is atomic from a concurrent reader's perspective —
 * partial states must never be observable. The SQLite implementation
 * relies on the database's own internal serialisation; there is no
 * higher-level lock in `SessionManager` (the docstring used to claim
 * a `live` map / FSM did this — there isn't one; only `TaskManager`
 * has that).
 *
 * Multi-step read-merge-save sequences in *callers* are NOT covered by
 * this contract. Two callers that each `read → mutate → save` the same
 * id concurrently can clobber each other's field updates (last writer
 * wins, regardless of the field they each touched). For field-scoped
 * updates that need to survive concurrency, use a dedicated patch
 * method like {@link SessionRepository.patchLastLaunchMode} instead of
 * read-merge-save. See issue #56 for the historical analysis.
 */
export interface SessionRepository {
  /**
   * Read the persistent state for `id`. Returns `null` when no
   * record exists. Throws a `SessionCorruptedError` when the on-disk
   * shape is invalid.
   */
  read(id: string): Promise<Session | null>;

  /**
   * Insert or replace the session's state. Atomic from a reader's
   * perspective: concurrent `read` calls see either the previous value
   * or the new one, never partial bytes.
   */
  save(id: string, state: Session): Promise<void>;

  /**
   * Atomically update *only* the `lastLaunchMode` column for `id`,
   * leaving every other persisted field untouched. No-op when the row
   * does not exist (mirrors `delete`'s idempotent semantics — callers
   * should not have to pre-check existence just to record a UI hint).
   *
   * See issue #56 for the historical race rationale.
   */
  patchLastLaunchMode(id: string, mode: "local" | "remote"): Promise<void>;

  /**
   * Set the persisted `agent` (FQN) for an existing row. Used by
   * `SessionManager.backfillAgentColumn` to populate the v2 column
   * for rows migrated up from v1 (which seeded `''` as the default).
   * No-op on missing rows.
   */
  setAgent(id: string, agent: string): Promise<void>;

  /**
   * Return the ids of every row whose persisted `agent` column is the
   * empty string. Used exclusively by the v1→v2 backfill (issue #120):
   * such rows are rejected by `Session.fromStored`'s non-empty-agent
   * check, so the normal `read` / `list` paths cannot surface them —
   * we need a direct id lookup that skips entity validation.
   */
  findEmptyAgentIds(): Promise<readonly string[]>;

  /**
   * Remove the session's state. Idempotent: deleting a missing id is a
   * no-op. Does NOT touch agent-owned content under the session's
   * workdir (e.g. AGENTS.md, runtime artifacts) — that concern lives in
   * `SessionManager.delete(id, { purge })`, not in the repository.
   */
  delete(id: string): Promise<void>;

  /**
   * Snapshot of every session this repository knows about, paired with
   * its id. Filters apply server-side where possible. The manager
   * post-filters by `agent` (which requires reading AGENTS.md) before
   * exposing the result to callers.
   */
  list(opts?: ListSessionStateOpts): Promise<{ id: string; state: Session }[]>;
}

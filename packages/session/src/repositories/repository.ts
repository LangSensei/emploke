/**
 * On-storage shape for a session — the slice of `Session` that the
 * `SessionRepository` actually persists. Excludes:
 *
 *   - `id`: the session's identity is the storage key, not duplicated
 *     in the value
 *   - `agent`: lives in the runtime-baked `AGENTS.md`, not in
 *     repository-managed metadata (the manager combines the two when
 *     producing a full `Session`)
 *   - `lastActiveAt` / `preview`: refreshed live from the runtime on
 *     every read, never persisted (would go stale immediately)
 *   - `workdir`: derived by the manager from the workspace layout, not
 *     stored
 *   - `schemaVersion`: an FS-Repository wire-format detail, not part
 *     of the domain
 *
 * Renamed from the old `PersistedSession` to break the old
 * "Persisted*" naming convention which leaked storage shape into the
 * public surface. The new name reflects what the type *is* (the
 * persistent state of a session) without saying *how* it's stored.
 */
export interface SessionState {
  /** Runtime kind (e.g. `"copilot"`, `"gemini"`). */
  readonly runtime: string;
  /** ISO 8601 UTC timestamp at session creation. */
  readonly createdAt: string;
  /**
   * Opaque id minted by the runtime for its own per-session state.
   * `null` when not yet known (e.g. discovery-only runtimes that lazy-mint).
   */
  readonly runtimeSessionId: string | null;
  /**
   * Mode the user chose for the most recent successful `buildInteractiveLaunch`
   * call against this session, or `undefined` if the session has never
   * been launched. Persisted so the dashboard can default the next
   * launch to the user's last intent (e.g. "this session is one I
   * always run remotely"), without forcing a global preference.
   */
  readonly lastLaunchMode?: "local" | "remote";
}

/**
 * Filter options for `SessionRepository.list`. Only fields the
 * repository can evaluate on its own appear here — the `agent` filter
 * lives in `SessionManager.list` because agent identity is determined
 * by reading `AGENTS.md`, not the repository's metadata.
 */
export interface ListSessionStateOpts {
  /**
   * Drop entries whose `createdAt` is strictly before this ISO 8601
   * timestamp. ISO strings sort lexicographically as dates, so the
   * compare is just `state.createdAt >= opts.createdSince`.
   */
  readonly createdSince?: string;
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
  read(id: string): Promise<SessionState | null>;

  /**
   * Insert or replace the session's state. Atomic from a reader's
   * perspective: concurrent `read` calls see either the previous value
   * or the new one, never partial bytes.
   */
  save(id: string, state: SessionState): Promise<void>;

  /**
   * Atomically update *only* the `lastLaunchMode` column for `id`,
   * leaving every other persisted field untouched. No-op when the row
   * does not exist (mirrors `delete`'s idempotent semantics — callers
   * should not have to pre-check existence just to record a UI hint).
   *
   * This exists as a field-scoped escape hatch from the read-merge-save
   * race in `SessionManager.buildInteractiveLaunch`: two concurrent
   * `buildInteractiveLaunch(id, { remote })` calls (e.g. user clicks "Resume Local"
   * in tab A and "Resume Remote" in tab B) used to lose one another's
   * `lastLaunchMode` write, and could in principle also clobber any
   * other field that some third path was concurrently updating. With
   * this method the column is updated in a single SQL statement, so
   * concurrent calls just resolve last-writer-wins on the column itself
   * without affecting `runtimeSessionId` / `runtime` / `createdAt`.
   * See issue #56.
   */
  patchLastLaunchMode(id: string, mode: "local" | "remote"): Promise<void>;

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
  list(opts?: ListSessionStateOpts): Promise<{ id: string; state: SessionState }[]>;
}

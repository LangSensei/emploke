import { SessionCorruptedError } from "./errors.js";

/** Mode the user chose for the most recent successful launch. */
export type SessionLaunchMode = "local" | "remote";

/**
 * Args accepted by {@link SessionState.create}. `runtimeSessionId` is
 * intentionally required (callers must pass `null` if not yet known)
 * so the construction site has to think about whether the runtime
 * minted an id eagerly or lazily.
 */
export interface SessionStateCreateArgs {
  /** Runtime kind (e.g. `"copilot"`, `"gemini"`). */
  readonly runtime: string;
  /** ISO 8601 UTC timestamp at session creation. */
  readonly createdAt: string;
  /**
   * Opaque id minted by the runtime for its own per-session state.
   * `null` when not yet known (e.g. discovery-only runtimes that lazy-mint).
   */
  readonly runtimeSessionId: string | null;
  /** Optional initial launch mode (rare — typically set later via withLastLaunchMode). */
  readonly lastLaunchMode?: SessionLaunchMode;
}

/**
 * Args accepted by {@link SessionState.fromStored}. Mirrors the public
 * field layout — the SQL row shape is a private detail of the
 * repository.
 */
export interface SessionStateFromStoredArgs {
  readonly id: string;
  readonly runtime: string;
  readonly createdAt: string;
  readonly runtimeSessionId: string | null;
  readonly lastLaunchMode?: SessionLaunchMode;
}

/**
 * Rich domain entity representing the **persistent state** of a single
 * session — the slice of `Session` that the repository actually stores
 * (runtime, createdAt, runtimeSessionId, lastLaunchMode).
 *
 * Excludes:
 *   - `id`: the session's identity is the storage key, not duplicated
 *     in the value
 *   - `agent`: lives in the runtime-baked `AGENTS.md`, not in
 *     repository-managed metadata (the manager combines the two when
 *     producing a full `Session`)
 *   - `lastActiveAt` / `preview`: refreshed live from the runtime on
 *     every read, never persisted (would go stale immediately)
 *   - `workdir`: derived by the manager from the workspace layout, not
 *     stored
 *
 * ## Construction
 *
 * - {@link SessionState.create} — for new state being persisted for
 *   the first time. Pure factory; no validation beyond shape.
 * - {@link SessionState.fromStored} — for entities reconstructed from
 *   storage. Validates every field; throws
 *   {@link SessionCorruptedError} when the row's shape is invalid.
 *
 * ## Mutation
 *
 * - {@link SessionState.withRuntimeSessionId} — record the runtime's
 *   id once it's been minted (used by the lazy-mint refresh path).
 * - {@link SessionState.withLastLaunchMode} — record the mode the
 *   user last launched in (used by the dashboard's Resume default).
 *
 * Mirrors the DDD style used by `@emploke/catalog`'s `Agent`,
 * `@emploke/workspace`'s `Workspace`, and `@emploke/task`'s `Task`.
 * See issue #84 for the rollup.
 */
export class SessionState {
  private constructor(
    private readonly _runtime: string,
    private readonly _createdAt: string,
    private readonly _runtimeSessionId: string | null,
    private readonly _lastLaunchMode: SessionLaunchMode | undefined,
  ) {}

  /**
   * Construct a fresh session state. Pure factory; validates only the
   * argument shape (TypeScript already pins the field types — the
   * factory exists to keep the construction surface symmetric with
   * `fromStored`).
   */
  static create(args: SessionStateCreateArgs): SessionState {
    return new SessionState(
      args.runtime,
      args.createdAt,
      args.runtimeSessionId,
      args.lastLaunchMode,
    );
  }

  /**
   * Reconstruct a session state from a storage-side row. Validates
   * every field; throws {@link SessionCorruptedError} (carrying the
   * stored `id` for operator triage) when the row's shape is invalid.
   * The repository decides what to do with corrupted rows (log + skip,
   * or rethrow).
   */
  static fromStored(args: SessionStateFromStoredArgs): SessionState {
    if (typeof args.runtime !== "string" || args.runtime.length === 0) {
      throw new SessionCorruptedError(args.id, "missing or invalid 'runtime'");
    }
    if (typeof args.createdAt !== "string" || args.createdAt.length === 0) {
      throw new SessionCorruptedError(args.id, "missing or invalid 'created_at'");
    }
    if (args.runtimeSessionId !== null && typeof args.runtimeSessionId !== "string") {
      throw new SessionCorruptedError(args.id, "'runtime_session_id' must be string or null");
    }
    if (
      args.lastLaunchMode !== undefined &&
      args.lastLaunchMode !== "local" &&
      args.lastLaunchMode !== "remote"
    ) {
      throw new SessionCorruptedError(
        args.id,
        "'last_launch_mode' must be 'local', 'remote', or null",
      );
    }
    return new SessionState(
      args.runtime,
      args.createdAt,
      args.runtimeSessionId,
      args.lastLaunchMode,
    );
  }

  get runtime(): string {
    return this._runtime;
  }
  get createdAt(): string {
    return this._createdAt;
  }
  get runtimeSessionId(): string | null {
    return this._runtimeSessionId;
  }
  get lastLaunchMode(): SessionLaunchMode | undefined {
    return this._lastLaunchMode;
  }

  /**
   * Record the runtime's session id once minted (used by lazy-mint
   * refresh paths). Identity (runtime / createdAt) is preserved.
   */
  withRuntimeSessionId(runtimeSessionId: string | null): SessionState {
    return new SessionState(this._runtime, this._createdAt, runtimeSessionId, this._lastLaunchMode);
  }

  /**
   * Record the mode the user last launched in. Used by the dashboard
   * to default the Resume button to the user's last intent. Identity
   * is preserved.
   */
  withLastLaunchMode(mode: SessionLaunchMode): SessionState {
    return new SessionState(this._runtime, this._createdAt, this._runtimeSessionId, mode);
  }

  /**
   * POJO projection. Used by tests that compare states; the manager
   * itself never serialises `SessionState` (the wire-level entity is
   * `Session`, which the manager builds by combining `SessionState`
   * with workdir / agent / lastActiveAt / preview).
   *
   * Optional `lastLaunchMode` is omitted when unset to preserve a
   * shape that round-trips through `JSON.parse(JSON.stringify(...))`.
   */
  toJSON(): Record<string, unknown> {
    return {
      runtime: this._runtime,
      createdAt: this._createdAt,
      runtimeSessionId: this._runtimeSessionId,
      ...(this._lastLaunchMode !== undefined ? { lastLaunchMode: this._lastLaunchMode } : {}),
    };
  }
}

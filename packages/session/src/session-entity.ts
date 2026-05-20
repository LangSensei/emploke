import { SessionCorruptedError } from "./errors.js";

/** Mode the user chose for the most recent successful launch. */
export type SessionLaunchMode = "local" | "remote";

/**
 * Args accepted by {@link Session.create}. `runtimeSessionId` is
 * intentionally required (callers must pass `null` if not yet known)
 * so the construction site has to think about whether the runtime
 * minted an id eagerly or lazily.
 */
export interface SessionCreateArgs {
  /** Runtime kind (e.g. `"copilot"`, `"gemini"`). */
  readonly runtime: string;
  /**
   * Agent FQN (`<scope>/<name>`) this session was provisioned with.
   * v2 (issue #120) promoted this from a derived-on-read AGENTS.md
   * frontmatter parse to a first-class persisted column. Frozen for
   * the lifetime of the row — manual edits to AGENTS.md after
   * provision do not propagate (mirrors `task.agent` semantics).
   */
  readonly agent: string;
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
 * Args accepted by {@link Session.fromStored}. Mirrors the public
 * field layout — the SQL row shape is a private detail of the
 * repository.
 */
export interface SessionFromStoredArgs {
  readonly id: string;
  readonly agent: string;
  readonly runtime: string;
  readonly createdAt: string;
  readonly runtimeSessionId: string | null;
  readonly lastLaunchMode?: SessionLaunchMode;
}

/**
 * Rich domain entity representing the **persisted** state of a single
 * session — the slice that the repository actually stores (runtime,
 * createdAt, runtimeSessionId, lastLaunchMode).
 *
 * Distinct from {@link SessionView} (in `./types.ts`), the wire-level
 * projection that combines this entity with workdir (computed from
 * layout), agent (parsed from `<workdir>/AGENTS.md` frontmatter), and
 * lastActiveAt + preview (refreshed live from the runtime per call).
 * The split exists because those three sources have different
 * persistence semantics: only `Session`'s fields belong in SQLite,
 * the rest are derived. `SessionView` is what `c.json(session)`
 * returns; `Session` is what the SQLite repository round-trips.
 *
 * ## Construction
 *
 * - {@link Session.create} — for new state being persisted for the
 *   first time. Pure factory; no validation beyond shape.
 * - {@link Session.fromStored} — for entities reconstructed from
 *   storage. Validates every field; throws
 *   {@link SessionCorruptedError} when the row's shape is invalid.
 *
 * ## Mutation
 *
 * - {@link Session.withRuntimeSessionId} — record the runtime's
 *   id once it's been minted (used by the lazy-mint refresh path).
 * - {@link Session.withLastLaunchMode} — record the mode the user
 *   last launched in (used by the dashboard's Resume default).
 *
 * Mirrors the DDD style used by `@emploke/catalog`'s `Agent`,
 * `@emploke/workspace`'s `Workspace`, and `@emploke/task`'s `Task`.
 * See issue #84 for the rollup.
 */
export class Session {
  private constructor(
    private readonly _runtime: string,
    private readonly _agent: string,
    private readonly _createdAt: string,
    private readonly _runtimeSessionId: string | null,
    private readonly _lastLaunchMode: SessionLaunchMode | undefined,
  ) {}

  /**
   * Construct a fresh session. Pure factory; validates only the
   * argument shape (TypeScript already pins the field types — the
   * factory exists to keep the construction surface symmetric with
   * `fromStored`).
   */
  static create(args: SessionCreateArgs): Session {
    return new Session(
      args.runtime,
      args.agent,
      args.createdAt,
      args.runtimeSessionId,
      args.lastLaunchMode,
    );
  }

  /**
   * Reconstruct a session from a storage-side row. Validates every
   * field; throws {@link SessionCorruptedError} (carrying the stored
   * `id` for operator triage) when the row's shape is invalid. The
   * repository decides what to do with corrupted rows (log + skip, or
   * rethrow).
   */
  static fromStored(args: SessionFromStoredArgs): Session {
    if (typeof args.runtime !== "string" || args.runtime.length === 0) {
      throw new SessionCorruptedError(args.id, "missing or invalid 'runtime'");
    }
    if (typeof args.agent !== "string" || args.agent.length === 0) {
      // v2 (issue #120): agent is persisted as a first-class column.
      // The migration backfills from `<workdir>/AGENTS.md` and falls
      // back to `''` when the file is missing/unreadable; such rows
      // surface as a SessionCorruptedError so the manager's read /
      // list paths log-and-skip rather than rendering a session with
      // an empty agent identity in the dashboard.
      throw new SessionCorruptedError(args.id, "missing or invalid 'agent'");
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
    return new Session(
      args.runtime,
      args.agent,
      args.createdAt,
      args.runtimeSessionId,
      args.lastLaunchMode,
    );
  }

  get runtime(): string {
    return this._runtime;
  }
  get agent(): string {
    return this._agent;
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
   * refresh paths). Identity (runtime / agent / createdAt) is preserved.
   */
  withRuntimeSessionId(runtimeSessionId: string | null): Session {
    return new Session(
      this._runtime,
      this._agent,
      this._createdAt,
      runtimeSessionId,
      this._lastLaunchMode,
    );
  }

  /**
   * Record the mode the user last launched in. Used by the dashboard
   * to default the Resume button to the user's last intent. Identity
   * is preserved.
   */
  withLastLaunchMode(mode: SessionLaunchMode): Session {
    return new Session(this._runtime, this._agent, this._createdAt, this._runtimeSessionId, mode);
  }

  /**
   * POJO projection. Used by tests that compare session contents; the
   * manager itself never serialises a `Session` directly (the
   * wire-level entity is `SessionView`, which the manager builds by
   * combining `Session` with workdir + lastActiveAt + preview).
   */
  toJSON(): Record<string, unknown> {
    return {
      runtime: this._runtime,
      agent: this._agent,
      createdAt: this._createdAt,
      runtimeSessionId: this._runtimeSessionId,
      ...(this._lastLaunchMode !== undefined ? { lastLaunchMode: this._lastLaunchMode } : {}),
    };
  }
}

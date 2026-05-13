import { CorruptedTaskError, InvalidTaskIdError, InvalidTransition } from "./errors.js";
import { assertValidTaskId, generateTaskId, TASK_ID_RE } from "./ids.js";
import type { TaskFailure, TaskResult, TaskStatus } from "./types.js";

const VALID_STATUSES = new Set<TaskStatus>([
  "not_started",
  "running",
  "success",
  "failure",
  "cancelled",
]);

/**
 * Args accepted by {@link Task.create}. Every field except `agent` and
 * `instructions` is optional; the factory fills in the rest.
 */
export interface TaskCreateArgs {
  /** Logical agent identifier. Opaque to the kernel. */
  readonly agent: string;
  readonly instructions: string;
  /** Optional initial metadata (e.g. caller-supplied tags, parentTaskId). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Override task id (deterministic for tests; otherwise a UUID v4). */
  readonly id?: string;
  /**
   * Override creation timestamp (ISO 8601 UTC string, e.g.
   * `"2025-01-01T00:00:00.000Z"`). Defaults to `new Date().toISOString()`.
   * Deterministic-test seam.
   */
  readonly createdAt?: string;
}

/**
 * Args accepted by {@link Task.fromStored}. Mirrors the public field
 * layout — the SQL row shape is a private detail of the repository.
 *
 * `id` is required (the row's primary key); the rest are storage-side
 * fields that {@link Task.fromStored} validates before construction.
 */
export interface TaskFromStoredArgs {
  readonly id: string;
  readonly agent: string;
  readonly instructions: string;
  readonly status: TaskStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly result?: TaskResult;
  readonly failure?: TaskFailure;
}

/**
 * Common opts accepted by every state-transition method. Both fields
 * are optional; sensible defaults apply when omitted.
 */
export interface TaskTransitionOpts {
  /**
   * Metadata patch to shallow-merge (last-wins) into the task's
   * existing metadata bag. Same semantics across `start` / `complete`
   * / `fail` / `cancel`. Omit to leave metadata untouched.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * ISO 8601 UTC timestamp to record on `startedAt` (for `start`) or
   * `endedAt` (for `complete` / `fail` / `cancel`). Defaults to
   * `new Date().toISOString()` — overridable for deterministic tests.
   */
  readonly now?: string;
}

/**
 * Rich domain entity representing a single autonomous task.
 *
 * Identity = `id`, immutable. `agent` / `instructions` / `createdAt`
 * are also immutable for the lifetime of the task — every state-
 * transition method ({@link Task.start} / {@link Task.complete} /
 * {@link Task.fail} / {@link Task.cancel}) preserves them. The runtime
 * never inspects `metadata` — it's an open-shape bag for runtime-
 * specific bookkeeping (PID, runtime session id, work dir, …).
 *
 * ## Construction
 *
 * - {@link Task.create} — for new tasks. Mints id + createdAt by
 *   default; status starts at `not_started`. Test seams accept
 *   overrides for both.
 * - {@link Task.fromStored} — for entities reconstructed from
 *   storage. Validates every field; throws {@link InvalidTaskIdError}
 *   (id syntax) or {@link CorruptedTaskError} (everything else).
 *
 * ## State machine
 *
 * The legal transitions are:
 *
 *   not_started ──start────► running
 *   not_started ──cancel───► cancelled   (allowed for pre-flight failures)
 *   running     ──complete─► success
 *   running     ──fail─────► failure
 *   running     ──cancel───► cancelled
 *
 * Terminal statuses (`success` / `failure` / `cancelled`) accept no
 * further transitions. Each method throws
 * {@link InvalidTransition} when called against an illegal source
 * status.
 *
 * ## Metadata enrichment
 *
 * {@link Task.withMetadata} replaces the metadata bag wholesale
 * without changing status. Used by `TaskManager` to fold in
 * runtime-supplied display metadata (title / lastActiveAt) on read,
 * which is not a state transition.
 *
 * Mirrors the DDD style used by `@emploke/catalog`'s `Agent` and
 * `@emploke/workspace`'s `Workspace`. See issue #84 for the rollup.
 */
export class Task {
  private constructor(
    private readonly _id: string,
    private readonly _agent: string,
    private readonly _instructions: string,
    private readonly _status: TaskStatus,
    private readonly _metadata: Readonly<Record<string, unknown>>,
    private readonly _createdAt: string,
    private readonly _startedAt: string | undefined,
    private readonly _endedAt: string | undefined,
    private readonly _result: TaskResult | undefined,
    private readonly _failure: TaskFailure | undefined,
  ) {}

  /**
   * Construct a fresh task in `not_started` status. Pure factory: the
   * only ambient effects are `generateTaskId()` (which calls
   * `crypto.randomBytes` + `new Date()` for the canonical
   * `YYYYMMDD-xxxxxxxx` id format) and `new Date().toISOString()`
   * (for `createdAt`).
   *
   * Both can be overridden via {@link TaskCreateArgs.id} /
   * {@link TaskCreateArgs.createdAt} for deterministic tests; an
   * explicit `id` is validated against {@link TASK_ID_RE} so the
   * entity can never carry an id the repository would reject at save
   * time. Use {@link Task.fromStored} when reconstructing a task from
   * a row that was written under an older schema.
   */
  static create(args: TaskCreateArgs): Task {
    const id = args.id ?? generateTaskId();
    if (args.id !== undefined) assertValidTaskId(id);
    return new Task(
      id,
      args.agent,
      args.instructions,
      "not_started",
      Object.freeze({ ...(args.metadata ?? {}) }),
      args.createdAt ?? new Date().toISOString(),
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  /**
   * Reconstruct a task from a storage-side row. Validates every field
   * — id format, status enum, ISO timestamps, metadata shape — and
   * throws {@link InvalidTaskIdError} (id syntax) or
   * {@link CorruptedTaskError} (everything else). The repository
   * decides what to do with corrupted rows (log + skip, or rethrow).
   */
  static fromStored(args: TaskFromStoredArgs): Task {
    if (!TASK_ID_RE.test(args.id)) throw new InvalidTaskIdError(args.id);
    if (typeof args.agent !== "string") {
      throw new CorruptedTaskError(args.id, "task.agent must be a string");
    }
    if (typeof args.instructions !== "string") {
      throw new CorruptedTaskError(args.id, "task.instructions must be a string");
    }
    if (typeof args.status !== "string" || !VALID_STATUSES.has(args.status)) {
      throw new CorruptedTaskError(
        args.id,
        `task.status must be one of: ${[...VALID_STATUSES].join(", ")}`,
      );
    }
    if (typeof args.createdAt !== "string") {
      throw new CorruptedTaskError(args.id, "task.created_at must be a string");
    }
    if (
      args.metadata === null ||
      typeof args.metadata !== "object" ||
      Array.isArray(args.metadata)
    ) {
      throw new CorruptedTaskError(args.id, "task.metadata must be an object");
    }
    return new Task(
      args.id,
      args.agent,
      args.instructions,
      args.status,
      Object.freeze({ ...args.metadata }),
      args.createdAt,
      args.startedAt,
      args.endedAt,
      args.result,
      args.failure,
    );
  }

  get id(): string {
    return this._id;
  }
  get agent(): string {
    return this._agent;
  }
  get instructions(): string {
    return this._instructions;
  }
  get status(): TaskStatus {
    return this._status;
  }
  get metadata(): Readonly<Record<string, unknown>> {
    return this._metadata;
  }
  get createdAt(): string {
    return this._createdAt;
  }
  get startedAt(): string | undefined {
    return this._startedAt;
  }
  get endedAt(): string | undefined {
    return this._endedAt;
  }
  get result(): TaskResult | undefined {
    return this._result;
  }
  get failure(): TaskFailure | undefined {
    return this._failure;
  }

  // ─── state transitions ────────────────────────────────────

  /**
   * Transition `not_started → running`. Throws {@link InvalidTransition}
   * from any other status.
   */
  start(opts: TaskTransitionOpts = {}): Task {
    if (this._status !== "not_started") {
      throw new InvalidTransition(this._status, "start");
    }
    return this.transition({
      status: "running",
      startedAt: opts.now ?? new Date().toISOString(),
      metadata: this.mergeMetadata(opts.metadata),
    });
  }

  /**
   * Transition `running → success`, attaching `output` as the result.
   * Throws {@link InvalidTransition} from any other status.
   *
   * `output` semantics: see the JSDoc on `TaskResult` in `./types.ts`.
   * Today emploke always passes `""` here under the runtime-driven
   * completion model; the field is pre-positioned for an
   * agent-driven completion model that lands a structured summary.
   */
  complete(output: string, opts: TaskTransitionOpts = {}): Task {
    if (this._status !== "running") {
      throw new InvalidTransition(this._status, "complete");
    }
    return this.transition({
      status: "success",
      endedAt: opts.now ?? new Date().toISOString(),
      result: { output },
      metadata: this.mergeMetadata(opts.metadata),
    });
  }

  /**
   * Transition `running → failure`, recording `error` for operator
   * visibility. Throws {@link InvalidTransition} from any other status.
   */
  fail(error: string, opts: TaskTransitionOpts = {}): Task {
    if (this._status !== "running") {
      throw new InvalidTransition(this._status, "fail");
    }
    return this.transition({
      status: "failure",
      endedAt: opts.now ?? new Date().toISOString(),
      failure: { error },
      metadata: this.mergeMetadata(opts.metadata),
    });
  }

  /**
   * Transition to `cancelled`. Legal from both `not_started` (so
   * pre-flight failures — e.g. provisioner can't write to disk —
   * can be reported without first moving the task to `running`) and
   * `running`. Throws {@link InvalidTransition} from terminal statuses.
   *
   * Note: `TaskManager` does not currently emit this transition; a
   * subprocess killed during `delete()` has its workdir removed
   * before any terminal event is applied, and `shutdown()` records
   * `failure` with reason "server shutdown". `cancel` is reserved
   * for a future user-cancel API (see the JSDoc on `TaskStatus`).
   */
  cancel(opts: TaskTransitionOpts = {}): Task {
    if (this._status !== "not_started" && this._status !== "running") {
      throw new InvalidTransition(this._status, "cancel");
    }
    return this.transition({
      status: "cancelled",
      endedAt: opts.now ?? new Date().toISOString(),
      metadata: this.mergeMetadata(opts.metadata),
    });
  }

  /**
   * Replace the metadata bag wholesale, preserving status + timing +
   * result + failure. Used by `TaskManager` to fold in runtime-
   * supplied display metadata (title / lastActiveAt) on read paths,
   * which is **not** a state transition.
   *
   * Callers that want a shallow merge do it themselves before passing
   * the merged bag — keeping replace-only here avoids a second
   * `merge?` flag every caller would otherwise have to pick.
   */
  withMetadata(metadata: Readonly<Record<string, unknown>>): Task {
    return new Task(
      this._id,
      this._agent,
      this._instructions,
      this._status,
      Object.freeze({ ...metadata }),
      this._createdAt,
      this._startedAt,
      this._endedAt,
      this._result,
      this._failure,
    );
  }

  // ─── serialisation ─────────────────────────────────────────

  /**
   * Public POJO projection. Called automatically by `JSON.stringify`
   * (e.g. by the server's `c.json(task)` route helpers), so HTTP
   * clients see the same field layout as the pre-DDD Task interface.
   * Optional fields (`startedAt`, `endedAt`, `result`, `failure`) are
   * omitted when unset to preserve byte-identical wire shape.
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      agent: this._agent,
      instructions: this._instructions,
      status: this._status,
      metadata: this._metadata,
      createdAt: this._createdAt,
      ...(this._startedAt !== undefined ? { startedAt: this._startedAt } : {}),
      ...(this._endedAt !== undefined ? { endedAt: this._endedAt } : {}),
      ...(this._result !== undefined ? { result: this._result } : {}),
      ...(this._failure !== undefined ? { failure: this._failure } : {}),
    };
  }

  // ─── internals ─────────────────────────────────────────────

  /**
   * Internal builder shared by every state-transition method.
   * Identity (id / agent / instructions / createdAt) is preserved
   * verbatim; the transition's own fields override.
   */
  private transition(patch: {
    readonly status: TaskStatus;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly result?: TaskResult;
    readonly failure?: TaskFailure;
  }): Task {
    return new Task(
      this._id,
      this._agent,
      this._instructions,
      patch.status,
      patch.metadata,
      this._createdAt,
      patch.startedAt !== undefined ? patch.startedAt : this._startedAt,
      patch.endedAt !== undefined ? patch.endedAt : this._endedAt,
      patch.result !== undefined ? patch.result : this._result,
      patch.failure !== undefined ? patch.failure : this._failure,
    );
  }

  /**
   * Shallow-merge an optional metadata patch into the existing bag.
   * Returns the existing reference unchanged when no patch is given —
   * tests pin this contract because callers (and serialisation
   * round-trips) sometimes assert metadata identity.
   */
  private mergeMetadata(
    patch: Readonly<Record<string, unknown>> | undefined,
  ): Readonly<Record<string, unknown>> {
    if (patch === undefined) return this._metadata;
    return Object.freeze({ ...this._metadata, ...patch });
  }
}

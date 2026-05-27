import { CorruptedTaskError, InvalidTaskIdError, InvalidTransition } from "./errors.js";
import type {
  TaskCancellation,
  TaskFailure,
  TaskOrigin,
  TaskStatus,
  TaskSuccess,
} from "./types.js";
import { assertValidTaskId, generateTaskId, TASK_ID_RE } from "./validate.js";

const VALID_STATUSES = new Set<TaskStatus>(["running", "succeeded", "failed", "cancelled"]);
const VALID_ORIGINS = new Set<TaskOrigin>(["standalone", "workflow", "schedule"]);

/**
 * Args accepted by {@link Task.create}. `agent` and `brief` are
 * required; everything else is optional and the factory fills in
 * defaults.
 */
export interface TaskCreateArgs {
  /** Logical agent identifier. Opaque to the kernel. */
  readonly agent: string;
  /**
   * Short, single-line task title (≤ 200 chars by contract; the
   * server validates the wire shape). Doubles as the displayed
   * label everywhere — task list rows, detail panel header, CLI
   * `task list` table, etc.
   */
  readonly brief: string;
  /** Optional long-form task body. */
  readonly details?: string;
  /** Optional initial metadata (e.g. caller-supplied tags, parentTaskId). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Who launched this task. Defaults to `'standalone'` when omitted —
   * a direct CLI / dashboard / MCP call. Workflow / future scheduler
   * call sites pass the matching {@link TaskOrigin} so dashboard /
   * CLI default views can hide non-standalone tasks.
   */
  readonly origin?: TaskOrigin;
  /** Override the task id (deterministic-test seam). */
  readonly id?: string;
  /** Override creation timestamp (ISO 8601 UTC string). */
  readonly createdAt?: string;
}

/**
 * Args accepted by {@link Task.fromStored}. Mirrors the public field
 * layout — the SQL row shape is a private detail of the repository.
 *
 * `id` is required (the row's primary key); the rest are storage-side
 * fields that {@link Task.fromStored} validates before construction.
 *
 * v4 (issue #119): `startedAt` is required (post-migration every row
 * has a non-null value — new dispatches set it at create time, legacy
 * rows backfill from `createdAt`). The terminal-payload fields
 * (`success` / `failure` / `cancellation`) are typed unions, not flat
 * column tuples.
 */
export interface TaskFromStoredArgs {
  readonly id: string;
  readonly agent: string;
  readonly brief: string;
  readonly details?: string;
  readonly origin: TaskOrigin;
  readonly status: TaskStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly success?: TaskSuccess;
  readonly failure?: TaskFailure;
  readonly cancellation?: TaskCancellation;
}

/** Common opts accepted by every state-transition method. */
export interface TaskTransitionOpts {
  /** Metadata patch to shallow-merge (last-wins) into the existing bag. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** ISO 8601 UTC timestamp to record on `endedAt`. */
  readonly now?: string;
}

/**
 * Rich domain entity representing a single autonomous task.
 *
 * Identity = `id`, immutable. `agent` / `brief` / `details` / `origin`
 * / `createdAt` / `startedAt` are immutable for the lifetime of the
 * task — every state-transition method preserves them. The runtime
 * never inspects `metadata` — it's an open-shape bag for runtime-
 * specific bookkeeping (PID, runtime session id, work dir, …).
 *
 * ## Construction
 *
 * - {@link Task.create} — for new tasks. Mints id + createdAt by
 *   default. Status starts directly at `running` (v4 dropped the
 *   `not_started` placeholder — see {@link TaskStatus}). `startedAt`
 *   is set to `createdAt` at create time so the column can be
 *   `NOT NULL` in the schema.
 * - {@link Task.fromStored} — for entities reconstructed from
 *   storage. Validates every field; throws {@link InvalidTaskIdError}
 *   (id syntax) or {@link CorruptedTaskError} (everything else).
 *
 * ## State machine
 *
 *   running ──complete─► succeeded
 *   running ──fail─────► failed
 *   running ──cancel───► cancelled
 *
 * Terminal statuses (`succeeded` / `failed` / `cancelled`) accept no
 * further transitions. Each method throws {@link InvalidTransition}
 * when called against an illegal source status.
 */
export class TaskEntity {
  private constructor(
    private readonly _id: string,
    private readonly _agent: string,
    private readonly _brief: string,
    private readonly _details: string | undefined,
    private readonly _origin: TaskOrigin,
    private readonly _status: TaskStatus,
    private readonly _metadata: Readonly<Record<string, unknown>>,
    private readonly _createdAt: string,
    private readonly _startedAt: string,
    private readonly _endedAt: string | undefined,
    private readonly _success: TaskSuccess | undefined,
    private readonly _failure: TaskFailure | undefined,
    private readonly _cancellation: TaskCancellation | undefined,
  ) {}

  /**
   * Construct a fresh task in `running` status. `startedAt` is set to
   * `createdAt` (v4 collapsed the `not_started` placeholder — there
   * is no intermediate state between dispatch and the subprocess
   * actually starting). Pure factory aside from the deterministic-
   * seamed `generateTaskId` and `new Date().toISOString()`.
   */
  static create(args: TaskCreateArgs): TaskEntity {
    const id = args.id ?? generateTaskId();
    if (args.id !== undefined) assertValidTaskId(id);
    if (typeof args.brief !== "string" || args.brief.length === 0) {
      throw new TypeError("Task.create: brief must be a non-empty string");
    }
    const createdAt = args.createdAt ?? new Date().toISOString();
    const origin = args.origin ?? "standalone";
    return new TaskEntity(
      id,
      args.agent,
      args.brief,
      args.details,
      origin,
      "running",
      Object.freeze({ ...(args.metadata ?? {}) }),
      createdAt,
      createdAt,
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
   * {@link CorruptedTaskError} (everything else).
   */
  static fromStored(args: TaskFromStoredArgs): TaskEntity {
    if (!TASK_ID_RE.test(args.id)) throw new InvalidTaskIdError(args.id);
    if (typeof args.agent !== "string") {
      throw new CorruptedTaskError(args.id, "task.agent must be a string");
    }
    if (typeof args.brief !== "string" || args.brief.length === 0) {
      throw new CorruptedTaskError(args.id, "task.brief must be a non-empty string");
    }
    if (args.details !== undefined && typeof args.details !== "string") {
      throw new CorruptedTaskError(args.id, "task.details, when present, must be a string");
    }
    if (typeof args.origin !== "string" || !VALID_ORIGINS.has(args.origin as TaskOrigin)) {
      throw new CorruptedTaskError(
        args.id,
        `task.origin must be one of: ${[...VALID_ORIGINS].join(", ")}`,
      );
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
    if (typeof args.startedAt !== "string" || args.startedAt.length === 0) {
      throw new CorruptedTaskError(args.id, "task.started_at must be a non-empty string");
    }
    if (
      args.metadata === null ||
      typeof args.metadata !== "object" ||
      Array.isArray(args.metadata)
    ) {
      throw new CorruptedTaskError(args.id, "task.metadata must be an object");
    }
    if (args.success !== undefined) {
      assertTaskSuccessShape(args.id, args.success);
    }
    if (args.failure !== undefined) {
      assertTaskFailureShape(args.id, args.failure);
    }
    if (args.cancellation !== undefined) {
      assertTaskCancellationShape(args.id, args.cancellation);
    }
    // Cross-field invariants: every terminal status carries its own
    // payload (and only its own), non-terminal statuses carry none.
    if (args.status === "succeeded" && args.success === undefined) {
      throw new CorruptedTaskError(args.id, "task.success is required when status is 'succeeded'");
    }
    if (args.status === "failed" && args.failure === undefined) {
      throw new CorruptedTaskError(args.id, "task.failure is required when status is 'failed'");
    }
    if (args.status === "cancelled" && args.cancellation === undefined) {
      throw new CorruptedTaskError(
        args.id,
        "task.cancellation is required when status is 'cancelled'",
      );
    }
    return new TaskEntity(
      args.id,
      args.agent,
      args.brief,
      args.details,
      args.origin,
      args.status,
      Object.freeze({ ...args.metadata }),
      args.createdAt,
      args.startedAt,
      args.endedAt,
      args.success,
      args.failure,
      args.cancellation,
    );
  }

  get id(): string {
    return this._id;
  }
  get agent(): string {
    return this._agent;
  }
  get brief(): string {
    return this._brief;
  }
  get details(): string | undefined {
    return this._details;
  }
  get origin(): TaskOrigin {
    return this._origin;
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
  get startedAt(): string {
    return this._startedAt;
  }
  get endedAt(): string | undefined {
    return this._endedAt;
  }
  get success(): TaskSuccess | undefined {
    return this._success;
  }
  get failure(): TaskFailure | undefined {
    return this._failure;
  }
  get cancellation(): TaskCancellation | undefined {
    return this._cancellation;
  }

  // ─── state transitions ────────────────────────────────────

  /**
   * Transition `running → succeeded`, attaching the typed success
   * payload. Throws {@link InvalidTransition} from any other status.
   */
  complete(success: TaskSuccess, opts: TaskTransitionOpts = {}): TaskEntity {
    if (this._status !== "running") {
      throw new InvalidTransition(this._status, "complete");
    }
    return this.transition({
      status: "succeeded",
      endedAt: opts.now ?? new Date().toISOString(),
      success,
      metadata: this.mergeMetadata(opts.metadata),
    });
  }

  /**
   * Transition `running → failed`, attaching `failure` for operator
   * visibility. Throws {@link InvalidTransition} from any other status.
   */
  fail(failure: TaskFailure, opts: TaskTransitionOpts = {}): TaskEntity {
    if (this._status !== "running") {
      throw new InvalidTransition(this._status, "fail");
    }
    return this.transition({
      status: "failed",
      endedAt: opts.now ?? new Date().toISOString(),
      failure,
      metadata: this.mergeMetadata(opts.metadata),
    });
  }

  /**
   * Transition `running → cancelled`. Throws {@link InvalidTransition}
   * from any other status.
   */
  cancel(cancellation: TaskCancellation, opts: TaskTransitionOpts = {}): TaskEntity {
    if (this._status !== "running") {
      throw new InvalidTransition(this._status, "cancel");
    }
    return this.transition({
      status: "cancelled",
      endedAt: opts.now ?? new Date().toISOString(),
      cancellation,
      metadata: this.mergeMetadata(opts.metadata),
    });
  }

  /**
   * Replace the metadata bag wholesale, preserving status + timing +
   * success / failure / cancellation payloads.
   */
  withMetadata(metadata: Readonly<Record<string, unknown>>): TaskEntity {
    return new TaskEntity(
      this._id,
      this._agent,
      this._brief,
      this._details,
      this._origin,
      this._status,
      Object.freeze({ ...metadata }),
      this._createdAt,
      this._startedAt,
      this._endedAt,
      this._success,
      this._failure,
      this._cancellation,
    );
  }

  // ─── serialisation ─────────────────────────────────────────

  /**
   * Public POJO projection. Called by `JSON.stringify`, so HTTP
   * clients see the same field layout as the in-process entity.
   *
   * Optional fields (`details`, `endedAt`, `success`, `failure`,
   * `cancellation`) are omitted when unset to keep the wire shape
   * minimal. `startedAt` is non-optional in v4 and always present.
   *
   * Exactly one of `success` / `failure` / `cancellation` is present
   * for the matching terminal status; none appear for `running`.
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      agent: this._agent,
      brief: this._brief,
      ...(this._details !== undefined ? { details: this._details } : {}),
      origin: this._origin,
      status: this._status,
      metadata: this._metadata,
      createdAt: this._createdAt,
      startedAt: this._startedAt,
      ...(this._endedAt !== undefined ? { endedAt: this._endedAt } : {}),
      ...(this._success !== undefined ? { success: this._success } : {}),
      ...(this._failure !== undefined ? { failure: this._failure } : {}),
      ...(this._cancellation !== undefined ? { cancellation: this._cancellation } : {}),
    };
  }

  // ─── internals ─────────────────────────────────────────────

  private transition(patch: {
    readonly status: TaskStatus;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly endedAt?: string;
    readonly success?: TaskSuccess;
    readonly failure?: TaskFailure;
    readonly cancellation?: TaskCancellation;
  }): TaskEntity {
    return new TaskEntity(
      this._id,
      this._agent,
      this._brief,
      this._details,
      this._origin,
      patch.status,
      patch.metadata,
      this._createdAt,
      this._startedAt,
      patch.endedAt !== undefined ? patch.endedAt : this._endedAt,
      patch.success !== undefined ? patch.success : this._success,
      patch.failure !== undefined ? patch.failure : this._failure,
      patch.cancellation !== undefined ? patch.cancellation : this._cancellation,
    );
  }

  private mergeMetadata(
    patch: Readonly<Record<string, unknown>> | undefined,
  ): Readonly<Record<string, unknown>> {
    if (patch === undefined) return this._metadata;
    return Object.freeze({ ...this._metadata, ...patch });
  }
}

// ─── payload shape validators ───────────────────────────────

const FAILURE_KINDS = new Set(["exited", "signal", "shutdown", "orphan", "internal"]);
const CANCELLATION_KINDS = new Set(["user", "cascade"]);

function assertTaskSuccessShape(id: string, value: TaskSuccess): void {
  if (value === null || typeof value !== "object") {
    throw new CorruptedTaskError(id, "task.success must be an object");
  }
  const v = value as { output?: unknown };
  if (v.output !== null && typeof v.output !== "string") {
    throw new CorruptedTaskError(id, "task.success.output must be a string or null");
  }
}

function assertTaskFailureShape(id: string, value: TaskFailure): void {
  if (value === null || typeof value !== "object") {
    throw new CorruptedTaskError(id, "task.failure must be an object");
  }
  const v = value as { kind?: unknown; message?: unknown; exit_code?: unknown; signal?: unknown };
  if (typeof v.kind !== "string" || !FAILURE_KINDS.has(v.kind)) {
    throw new CorruptedTaskError(
      id,
      `task.failure.kind must be one of: ${[...FAILURE_KINDS].join(", ")}`,
    );
  }
  if (typeof v.message !== "string") {
    throw new CorruptedTaskError(id, "task.failure.message must be a string");
  }
  if (v.kind === "exited" && typeof v.exit_code !== "number") {
    throw new CorruptedTaskError(id, "task.failure.exit_code must be a number when kind='exited'");
  }
  if (v.kind === "signal" && typeof v.signal !== "string") {
    throw new CorruptedTaskError(id, "task.failure.signal must be a string when kind='signal'");
  }
}

function assertTaskCancellationShape(id: string, value: TaskCancellation): void {
  if (value === null || typeof value !== "object") {
    throw new CorruptedTaskError(id, "task.cancellation must be an object");
  }
  const v = value as { kind?: unknown; message?: unknown };
  if (typeof v.kind !== "string" || !CANCELLATION_KINDS.has(v.kind)) {
    throw new CorruptedTaskError(
      id,
      `task.cancellation.kind must be one of: ${[...CANCELLATION_KINDS].join(", ")}`,
    );
  }
  if (typeof v.message !== "string") {
    throw new CorruptedTaskError(id, "task.cancellation.message must be a string");
  }
}

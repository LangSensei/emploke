/**
 * Domain types for @emploke/task.
 *
 * Task is a pure value type. It captures *what task, what status, what
 * result* — and nothing about how a particular runtime actually executes
 * it. All runtime-specific bookkeeping (PID, session file, work dir,
 * upstream session id, …) lives in {@link Task.metadata}.
 *
 * Why metadata instead of named fields:
 *  - The Task type never has to change when a new runtime arrives.
 *  - SDK runtimes (no PID), serverless runtimes (no work dir), and
 *    classic CLI runtimes can all coexist.
 *  - Mirrors the kernel `Capability.Metadata` convention from the Go
 *    archive — emploke "stores but never reads" runtime metadata.
 */

import type { CatalogManager } from "@emploke/catalog";
import type { RuntimeRegistry } from "@emploke/runtime";

/**
 * Status lifecycle: `not_started → running → success | failure | cancelled`.
 *
 * Note on `cancelled`: the kernel FSM accepts a `cancel` event (see `apply()`),
 * but `TaskManager` does not currently emit one. A subprocess killed during
 * `delete()` has its workdir removed before any terminal event is applied; a
 * subprocess killed during `shutdown()` is recorded as `failure` with reason
 * "server shutdown". The `cancelled` status is therefore reserved for a
 * future user-cancel API (e.g. `TaskManager.cancel(id)` + a `POST .../cancel`
 * route) that lets users distinguish "I asked it to stop" from "it crashed".
 * The dashboard already renders a `Cancelled` label so the UI need not change
 * when that API arrives.
 */
export type TaskStatus = "not_started" | "running" | "success" | "failure" | "cancelled";

/** A status from which no further transitions are legal. */
export type TerminalStatus = "success" | "failure" | "cancelled";

/**
 * Result attached when a Task transitions to `success`.
 *
 * `output` semantics under the current **runtime-driven completion model**:
 * the kernel does not interpret what an autonomous agent produced. The
 * substantive output of an agent run lives on the filesystem under
 * `Task.metadata.workdir/` — agent-written files, captured `stdout.log`,
 * and the runtime's per-task event stream junctioned in at `session/`. The
 * `output` string is intentionally minimal and may be empty: today
 * `TaskManager` always writes `""` here. A future, agent-driven completion
 * model (where the agent submits a structured deliverable summary back to
 * the kernel) would carry that summary in this field; the kernel shape is
 * pre-positioned for it.
 */
export interface TaskResult {
  readonly output: string;
}

export interface TaskFailure {
  readonly error: string;
}

export interface Task {
  readonly id: string;
  /** Logical identifier of the agent that owns this task — opaque string. */
  readonly agent: string;
  readonly instructions: string;
  readonly status: TaskStatus;
  /**
   * Open-shape bag for runtime-specific bookkeeping. The Task kernel never
   * inspects these values; runtimes own their own keys (and, by convention,
   * publish a typed reader from their package).
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * ISO 8601 UTC timestamp (e.g. `"2025-06-01T12:00:00.000Z"`). Stored as a
   * string so the Task is JSON-trivial: `JSON.stringify` / `JSON.parse`
   * round-trip without any custom (de)serialization, and the value is truly
   * immutable (a `Date` could otherwise be mutated in place).
   */
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly result?: TaskResult;
  readonly failure?: TaskFailure;
}

/**
 * Discriminated union of state-transition events. Every variant accepts
 * an optional `metadata` patch that is shallow-merged (last-wins) into
 * `Task.metadata`. `metadata` is the *only* extension point — the kernel
 * does not gain new event types lightly.
 */
export type TaskEvent = StartEvent | CompleteEvent | FailEvent | CancelEvent;

export interface StartEvent {
  readonly type: "start";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CompleteEvent {
  readonly type: "complete";
  readonly output: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FailEvent {
  readonly type: "fail";
  readonly error: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CancelEvent {
  readonly type: "cancel";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ─── TaskManager-side types ───────────────────────────────────

/**
 * Pluggable logger surface. Re-exported from `@emploke/logger` so we
 * keep a single canonical definition; this re-export exists for source
 * compatibility with callers that previously imported `Logger` from
 * `@emploke/task` directly.
 */
export type { Logger } from "@emploke/logger";

import type { Logger as _Logger } from "@emploke/logger";
import type { TaskRepository } from "./repositories/repository.js";

/** Constructor options for `TaskManager`. */
export interface TaskManagerConfig {
  readonly catalog: CatalogManager;
  readonly runtimeRegistry: RuntimeRegistry;
  /** Absolute path to the directory holding per-task workdirs. */
  readonly tasksDir: string;
  /** Default runtime kind to use when `dispatch` doesn't override. */
  readonly defaultRuntime?: string;
  /**
   * Persistence backend for task state. When omitted, the manager
   * constructs a `FsTaskRepository({ tasksDir })` automatically; tests
   * can inject an `InMemoryTaskRepository` (from `@emploke/task/testing`)
   * to skip filesystem orchestration.
   */
  readonly repository?: TaskRepository;
  readonly logger?: _Logger;
  /** Test seam: clock injection. */
  readonly now?: () => Date;
  /** Test seam: random source for id generation. */
  readonly randomBytes?: (n: number) => Buffer;
}

/** Inputs to `TaskManager.dispatch`. */
export interface DispatchOpts {
  /** Catalog name of the agent to run. Required. */
  readonly agent: string;
  /** Free-form prompt / instructions for the agent. */
  readonly instructions: string;
  /** Override the configured `defaultRuntime`. */
  readonly runtime?: string;
}

/**
 * Options for `TaskManager.list`. Mirrors the shape of
 * `@emploke/session`'s `ListSessionOpts` so callers see a consistent
 * filter API across the two managers.
 *
 * Filters are applied AFTER reading `task.json` (cheap) but the
 * filtered set is still the only thing returned to the caller — server
 * routes can therefore push their own filter inputs down to the
 * manager and avoid serialising entries the dashboard would discard.
 */
export interface ListTaskOpts {
  /** Filter to tasks whose `agent` matches this exact value. */
  readonly agent?: string;
  /**
   * Drop tasks whose `createdAt` is strictly before this ISO 8601
   * timestamp. ISO 8601 strings (Z-suffixed) sort lexicographically as
   * dates, so the comparison is a plain string `<`.
   */
  readonly createdSince?: string;
  /**
   * Filter to tasks whose `metadata.runtime` matches this exact value.
   * Useful for the dashboard's runtime dropdown filter.
   */
  readonly runtime?: string;
  /**
   * Filter to tasks in one of the listed statuses. The dashboard uses
   * this for the auto-poll path (`status=running`) so the server can
   * answer "do I have anything still in flight?" without serialising
   * every terminal task.
   */
  readonly statuses?: readonly TaskStatus[];
}

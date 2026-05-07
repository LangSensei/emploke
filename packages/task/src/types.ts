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

/** Status lifecycle: `not_started → running → success | failure | cancelled`. */
export type TaskStatus = "not_started" | "running" | "success" | "failure" | "cancelled";

/** A status from which no further transitions are legal. */
export type TerminalStatus = "success" | "failure" | "cancelled";

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

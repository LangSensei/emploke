/**
 * Error hierarchy for @emploke/task.
 *
 * All errors extend {@link TaskError} so consumers can `catch (e)` then
 * narrow with `instanceof`.
 */

import type { BlockedReason } from "./ports.js";

export class TaskError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskError";
  }
}

/**
 * Thrown by Task state-transition methods ({@link Task.start} /
 * {@link Task.complete} / {@link Task.fail} / {@link Task.cancel})
 * when the call is not legal in the task's current status (e.g.
 * `start()` on an already-running task, or any transition on a
 * terminal task).
 */
export class InvalidTransition extends TaskError {
  override readonly name = "InvalidTransition";

  constructor(
    public readonly from: string,
    public readonly eventType: string,
  ) {
    super(`invalid transition: cannot apply "${eventType}" event to task in "${from}" status`);
  }
}

/**
 * Thrown when a caller-supplied task id does not match the canonical
 * `YYYYMMDD-xxxxxxxx` pattern. Defense against malformed ids being used
 * to construct file system paths.
 */
export class InvalidTaskIdError extends TaskError {
  override readonly name = "InvalidTaskIdError";

  constructor(public readonly id: unknown) {
    super(`invalid task id: ${JSON.stringify(id)}`);
  }
}

/**
 * Thrown by `TaskService.dispatch` when the agent name does not resolve
 * in the catalog. The original cause (whatever the catalog threw) is
 * attached as `this.cause`.
 */
export class AgentNotFoundError extends TaskError {
  override readonly name = "AgentNotFoundError";

  constructor(
    public readonly agent: string,
    cause?: Error,
  ) {
    super(`agent not found: ${JSON.stringify(agent)}`, { cause });
  }
}

/**
 * Thrown by `TaskService.dispatch` when the catalog raises an error
 * that is NOT "agent does not exist" — e.g. parser failure, DB-corruption,
 * or any other system-level fault while resolving the agent. The
 * original cause is attached as `this.cause` for the server's `5xx
 * fault` log line; the route layer collapses the body to an opaque
 * `{ error: "internal error", code: "AgentResolutionFailedError" }`
 * so internal diagnostics never reach the wire.
 *
 * This is structurally distinct from {@link AgentNotFoundError}:
 *   - `AgentNotFoundError` → 400 (user passed a bad agent name)
 *   - `AgentResolutionFailedError` → 500 (catalog itself misbehaved)
 */
export class AgentResolutionFailedError extends TaskError {
  override readonly name = "AgentResolutionFailedError";

  constructor(
    public readonly agent: string,
    cause?: unknown,
  ) {
    super(`agent resolution failed: ${JSON.stringify(agent)}`, { cause });
  }
}

/**
 * Thrown by `TaskService.get` / `delete` when the requested id has no
 * persisted record (no row in the workspace's `tasks` table and, in
 * default-archive mode, the row is unparseable; in `purge: true` mode,
 * the workdir is absent too).
 */
export class TaskNotFoundError extends TaskError {
  override readonly name = "TaskNotFoundError";

  constructor(public readonly id: string) {
    super(`task not found: ${JSON.stringify(id)}`);
  }
}

/**
 * Thrown by `TaskService.dispatch` when the chosen runtime does not
 * implement the optional `dispatchTask` method. Surfaced to the user as
 * a clear "this CLI can't run autonomous tasks" rather than a confusing
 * `TypeError: dispatchTask is not a function`.
 */
export class RuntimeDoesNotSupportTasksError extends TaskError {
  override readonly name = "RuntimeDoesNotSupportTasksError";

  constructor(public readonly runtime: string) {
    super(`runtime ${JSON.stringify(runtime)} does not support task dispatch`);
  }
}

/**
 * Thrown by `TaskService.dispatch` when the agent (or one of its
 * transitive deps) is currently `blocked` — typically because:
 *   - the agent's prereqs haven't been acknowledged yet
 *   - the agent has been disabled by the user
 *   - a transitive skill / mcp is missing or itself blocked
 *
 * Carries the structured `BlockedReason` so callers (HTTP handlers,
 * CLI) can render a useful "here's what to fix" message.
 */
export class EntryNotReadyError extends TaskError {
  override readonly name = "EntryNotReadyError";

  constructor(
    public readonly agent: string,
    public readonly reason: BlockedReason | undefined,
  ) {
    super(`agent ${JSON.stringify(agent)} is not ready: ${summariseReason(reason)}`);
  }
}

function summariseReason(r: BlockedReason | undefined): string {
  if (r === undefined) return "blocked";
  const parts: string[] = [];
  if (r.disabledByUser) parts.push("disabled by user");
  if (r.needsPrereqsAck) parts.push("prereqs not acknowledged");
  if (r.orphaned) parts.push("orphaned");
  if (r.missingDeps && r.missingDeps.length > 0) {
    parts.push(`missing deps (${r.missingDeps.length})`);
  }
  if (r.blockedDeps && r.blockedDeps.length > 0) {
    parts.push(`blocked deps: ${r.blockedDeps.map((d: { fqn: string }) => d.fqn).join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "blocked";
}

/**
 * Thrown when `TaskService.dispatch` exhausts its mkdir-retry budget
 * trying to allocate a fresh task id (vanishingly unlikely in practice
 * — a 4-byte random suffix gives 2^32 ids per day).
 */
export class TaskIdAllocationFailedError extends TaskError {
  override readonly name = "TaskIdAllocationFailedError";

  constructor(public readonly attempts: number) {
    super(`failed to allocate a unique task id after ${attempts} attempts`);
  }
}

/**
 * Thrown when `TaskRepository.read` finds a persisted row whose shape
 * or `schemaVersion` is incompatible with the current build. Manager's
 * `recoverOrphaned` path may catch and quarantine; direct `read(id)` callers
 * (e.g. the dashboard's "open task" path) propagate it as a 5xx.
 */
export class CorruptedTaskError extends TaskError {
  override readonly name = "CorruptedTaskError";

  constructor(
    public readonly id: string,
    public readonly reason: string,
  ) {
    super(`task ${id} is corrupted: ${reason}`);
  }
}

/**
 * Thrown by `TaskService.dispatch()` and `TaskService.cancel()` when
 * the manager has begun shutting down. The HTTP route maps this to
 * **503 Service Unavailable** so callers (CLI, dashboard) can show a
 * one-shot "server is restarting" toast and retry once the new server
 * is up. Both verbs throw the same typed error so the route layer
 * maps each cleanly to 503 instead of falling through to a default
 * 400.
 */
export class ManagerShuttingDownError extends TaskError {
  override readonly name = "ManagerShuttingDownError";

  constructor() {
    super("task manager is shutting down");
  }
}

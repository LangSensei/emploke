/**
 * Error hierarchy for @emploke/task.
 *
 * All errors extend {@link TaskError} so consumers can `catch (e)` then
 * narrow with `instanceof`.
 */

export class TaskError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Thrown by {@link apply} when an event is not legal in the task's current
 * status (e.g. `start` on an already-running task, or any event on a
 * terminal task).
 */
export class InvalidTransition extends TaskError {
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
  constructor(public readonly id: unknown) {
    super(`invalid task id: ${JSON.stringify(id)}`);
  }
}

/**
 * Thrown by `TaskManager.dispatch` when the agent name does not resolve
 * in the catalog. The original cause (whatever the catalog threw) is
 * attached as `this.cause`.
 */
export class AgentNotFoundError extends TaskError {
  constructor(
    public readonly agent: string,
    cause?: Error,
  ) {
    super(`agent not found: ${JSON.stringify(agent)}`, { cause });
  }
}

/**
 * Thrown by `TaskManager.get` / `delete` when the requested id has no
 * persisted record (dir missing, task.json missing, or task.json is
 * structurally unusable).
 */
export class TaskNotFoundError extends TaskError {
  constructor(public readonly id: string) {
    super(`task not found: ${JSON.stringify(id)}`);
  }
}

/**
 * Thrown by `TaskManager.dispatch` when the chosen runtime does not
 * implement the optional `dispatchTask` method. Surfaced to the user as
 * a clear "this CLI can't run autonomous tasks" rather than a confusing
 * `TypeError: dispatchTask is not a function`.
 */
export class RuntimeDoesNotSupportTasksError extends TaskError {
  constructor(public readonly runtime: string) {
    super(`runtime ${JSON.stringify(runtime)} does not support task dispatch`);
  }
}

/**
 * Thrown when `TaskManager.dispatch` exhausts its mkdir-retry budget
 * trying to allocate a fresh task id (vanishingly unlikely in practice
 * — a 4-byte random suffix gives 2^32 ids per day).
 */
export class TaskIdAllocationFailedError extends TaskError {
  constructor(public readonly attempts: number) {
    super(`failed to allocate a unique task id after ${attempts} attempts`);
  }
}

/**
 * Thrown when `TaskRepository.read` finds a `task.json` whose shape or
 * `schemaVersion` is incompatible with the current build. Manager's
 * `recoverOrphaned` may catch and quarantine; direct `read(id)` callers
 * (e.g. the dashboard's "open task" path) propagate it as a 5xx.
 */
export class CorruptedTaskError extends TaskError {
  constructor(
    public readonly id: string,
    public readonly reason: string,
  ) {
    super(`task ${id} is corrupted: ${reason}`);
  }
}

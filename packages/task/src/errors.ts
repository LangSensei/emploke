/**
 * Error hierarchy for @emploke/task.
 *
 * All errors extend {@link TaskError} so consumers can `catch (e)` then
 * narrow with `instanceof`.
 */

export class TaskError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
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

/**
 * Error hierarchy for `@emploke/schedule`. All errors extend
 * {@link ScheduleError} so callers can `instanceof` a coarse check
 * within the same realm; cross-realm callers (HTTP routes, CLI)
 * should branch on the stable `name` string literal.
 */

export class ScheduleError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "ScheduleError";
  }
}

export class ScheduleNotFoundError extends ScheduleError {
  override readonly name = "ScheduleNotFoundError";
  constructor(public readonly id: string) {
    super(`Schedule "${id}" not found`);
  }
}

export class InvalidScheduleIdError extends ScheduleError {
  override readonly name = "InvalidScheduleIdError";
  constructor(public readonly id: string) {
    super(`Invalid schedule id: "${id}"`);
  }
}

export class InvalidCronExprError extends ScheduleError {
  override readonly name = "InvalidCronExprError";
  constructor(
    public readonly expr: string,
    reason: string,
  ) {
    super(`Invalid cron expression "${expr}": ${reason}`);
  }
}

export class InvalidTimezoneError extends ScheduleError {
  override readonly name = "InvalidTimezoneError";
  constructor(public readonly tz: string) {
    super(`Invalid IANA timezone: "${tz}"`);
  }
}

export class AgentNotFoundError extends ScheduleError {
  override readonly name = "AgentNotFoundError";
  constructor(
    public readonly agent: string,
    options?: { cause?: unknown },
  ) {
    super(`Agent "${agent}" not found`, options);
  }
}

/**
 * Thrown by `ScheduleService.assertAgentExists` when the injected
 * `agentValidator` raises an error that is NOT an instance of
 * `@emploke/schedule`'s own {@link AgentNotFoundError} — i.e. the
 * underlying catalog returned a parser failure, DB corruption, or any
 * other system-level fault. Distinct from {@link AgentNotFoundError}:
 *   - `AgentNotFoundError` → 400 (user passed a bad agent name)
 *   - `AgentResolutionFailedError` → 500 (catalog itself misbehaved)
 *
 * The original cause is attached via the options bag for the server's
 * `5xx fault` log line; the route layer collapses the body to an
 * opaque `{ error: "internal error", code: "AgentResolutionFailedError" }`
 * so internal diagnostics never reach the wire.
 */
export class AgentResolutionFailedError extends ScheduleError {
  override readonly name = "AgentResolutionFailedError";
  constructor(
    public readonly agent: string,
    options?: { cause?: unknown },
  ) {
    super(`Agent "${agent}" resolution failed`, options);
  }
}

export class ScheduleEnabledError extends ScheduleError {
  override readonly name = "ScheduleEnabledError";
  constructor(public readonly id: string) {
    super(`Schedule "${id}" cannot be deleted while enabled; disable it first`);
  }
}

export class ScheduleHasInFlightError extends ScheduleError {
  override readonly name = "ScheduleHasInFlightError";
  constructor(public readonly id: string) {
    super(`Schedule "${id}" cannot be deleted while a fired task is still in flight`);
  }
}

/**
 * The schedule exists but does not have the kind required by the
 * kind-discriminated route (e.g. `PATCH /schedules/task/:sid` invoked
 * with a `:sid` whose `target.kind !== "task"`).
 *
 * The HTTP layer projects this to a plain `ScheduleNotFoundError`-
 * envelope 404 so the wire shape does not leak whether the resource
 * exists under another kind. The distinct class is retained so the
 * server-side code path and tests can branch unambiguously.
 */
export class ScheduleKindMismatchError extends ScheduleError {
  override readonly name = "ScheduleKindMismatchError";
  constructor(
    public readonly id: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Schedule "${id}" has target.kind="${actual}", expected "${expected}" for this route`);
  }
}

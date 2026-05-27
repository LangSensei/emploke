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

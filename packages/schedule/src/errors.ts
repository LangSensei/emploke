/**
 * Error hierarchy for `@emploke/schedule`. All errors extend
 * {@link ScheduleError} so callers can `instanceof` a coarse check
 * within the same realm; cross-realm callers (HTTP routes, CLI)
 * should branch on the stable `name` string literal.
 *
 * Agent-related errors live in `@emploke/task` (`AgentNotFoundError`,
 * `AgentResolutionFailedError`). The schedule pkg deliberately knows
 * nothing about agents — they are a concept owned by the task kind's
 * handler (see `packages/api/src/wiring/schedule-task-handler.ts`).
 * Catalog misses surface those task-pkg classes directly through the
 * schedule service; the server's schedules-error-policy table has a
 * single row for each.
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

export class ScheduleEnabledError extends ScheduleError {
  override readonly name = "ScheduleEnabledError";
  constructor(public readonly id: string) {
    super(`Schedule "${id}" cannot be deleted while enabled; disable it first`);
  }
}

export class ScheduleHasInFlightError extends ScheduleError {
  override readonly name = "ScheduleHasInFlightError";
  constructor(public readonly id: string) {
    super(`Schedule "${id}" cannot be deleted while a fired dispatch is still in flight`);
  }
}

/**
 * The schedule exists but does not have the kind required by the
 * kind-discriminated route (e.g. `PATCH /schedules/task/:sid` invoked
 * with a `:sid` whose `target.kind !== "task"`).
 *
 * Thrown by `ScheduleService.patch` when the caller passes
 * `args.expectedKind` and the loaded entity disagrees. The HTTP layer
 * projects this to a plain `ScheduleNotFoundError`-envelope 404 so
 * the wire shape does not leak whether the resource exists under
 * another kind. The distinct class is retained so the server-side
 * code path and tests can branch unambiguously.
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

/**
 * Thrown by `ScheduleService.registerKind` when the same kind name is
 * registered twice on the same service instance. Operator-config bug —
 * the server's policy maps this to 500 with an opaque body.
 */
export class ScheduleKindAlreadyRegisteredError extends ScheduleError {
  override readonly name = "ScheduleKindAlreadyRegisteredError";
  constructor(public readonly kind: string) {
    super(`Schedule kind "${kind}" is already registered on this service`);
  }
}

/**
 * Thrown when a schedule operation references a kind for which no
 * handler has been registered. Two sources:
 *
 *   1. `ScheduleService.create({ target: { kind: "X", ... } })` where
 *      `"X"` is unknown to the service.
 *   2. `ScheduleService.recover()` preflight discovers a DB row whose
 *      `target_kind` was not registered by the caller before
 *      `recover()` ran (so the registry froze without it). The
 *      `message` in that case names the row id and the
 *      register-before-recover requirement.
 *
 * Both are operator-config bugs (the caller forgot to call
 * `service.registerKind(kind, handler)` at compose time) — 500 with
 * an opaque body.
 */
export class ScheduleKindNotRegisteredError extends ScheduleError {
  override readonly name = "ScheduleKindNotRegisteredError";
  constructor(
    public readonly kind: string,
    message?: string,
  ) {
    super(
      message ??
        `No handler registered for schedule kind "${kind}". Call service.registerKind("${kind}", handler) at compose time before service.recover().`,
    );
  }
}

/**
 * Thrown when `ScheduleService.registerKind` is called after
 * `recover()` froze the registry. Indicates an ordering bug at
 * compose time. Operator-config — 500 with opaque body.
 */
export class ScheduleKindRegistryFrozenError extends ScheduleError {
  override readonly name = "ScheduleKindRegistryFrozenError";
  constructor(public readonly kind: string) {
    super(
      `Cannot register schedule kind "${kind}": the registry was frozen by a prior service.recover() call. All registerKind() calls must precede recover().`,
    );
  }
}

/**
 * Thrown when `ListScheduleOpts.dataEquals.path` fails the
 * `^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$` grammar guard. The path is
 * string-concatenated into the SQL fragment for `json_extract`, so
 * the grammar guard is the SQL-injection defence (the value is
 * parameter-bound separately and is safe). Caller-supplied input is
 * the only legitimate trigger — operator-config / caller bug, 400.
 */
export class InvalidJsonPathError extends ScheduleError {
  override readonly name = "InvalidJsonPathError";
  constructor(public readonly path: string) {
    super(
      `Invalid JSON path "${path}". Must match ^$(\\.[a-zA-Z_][a-zA-Z0-9_]*)+$ (e.g. "$.agent", "$.workflow.id").`,
    );
  }
}

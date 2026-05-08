/**
 * Thrown when a `Session.runtime` value names a runtime that hasn't been
 * registered in the active `RuntimeRegistry`. Typically indicates a
 * configuration mismatch between the server and the on-disk session records
 * (e.g. session was created with a runtime that has since been removed).
 */
export class UnknownRuntimeError extends Error {
  constructor(public readonly kind: string) {
    super(`unknown runtime: ${JSON.stringify(kind)}`);
    this.name = "UnknownRuntimeError";
  }
}

/**
 * Wraps a failure that happened inside `Runtime.refresh`. The original cause
 * is attached as `this.cause` per ES2022 conventions.
 */
export class RuntimeRefreshFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly sessionId: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" refresh failed for session ${sessionId}: ${cause.message}`);
    this.name = "RuntimeRefreshFailed";
    this.cause = cause;
  }
}

/**
 * Wraps a failure that happened inside `Runtime.deleteState`. The original
 * cause is attached as `this.cause`.
 */
export class RuntimeStateDeletionFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly sessionId: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" deleteState failed for session ${sessionId}: ${cause.message}`);
    this.name = "RuntimeStateDeletionFailed";
    this.cause = cause;
  }
}

/**
 * Wraps a failure that happened inside `Runtime.provision`.
 */
export class RuntimeProvisionFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly workdir: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" provision failed at ${workdir}: ${cause.message}`);
    this.name = "RuntimeProvisionFailed";
    this.cause = cause;
  }
}

/**
 * Wraps a failure that happened inside `Runtime.registerWorkspace`.
 * Thrown when the runtime cannot complete its one-time setup against a
 * workspace root (e.g. cannot persist a trust entry to its CLI's settings
 * file).
 */
export class RuntimeRegisterWorkspaceFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly workspaceDir: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" registerWorkspace failed at ${workspaceDir}: ${cause.message}`);
    this.name = "RuntimeRegisterWorkspaceFailed";
    this.cause = cause;
  }
}

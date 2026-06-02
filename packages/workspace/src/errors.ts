/**
 * Error hierarchy for `@emploke/workspace` registry/domain failures.
 * Every error class defined in this file extends `WorkspaceError`, so
 * callers can `instanceof WorkspaceError` for a coarse "is this a
 * registry/domain error?" check; specific subclasses below carry
 * typed context (the offending id / name / path).
 *
 * Note: `InputValidationError` (defined in `validate.ts`, also
 * exported from the public barrel) is a separate hierarchy that
 * extends `Error` directly — `instanceof WorkspaceError` will NOT
 * catch it. See the "Errors" section of the README for the
 * catch-block contract.
 *
 * `RegistryError` is a sub-base for errors originating in the registry
 * table itself (id / path conflicts, missing rows, raw constraint
 * violations). Name validation is independent of the registry and
 * lives directly under `WorkspaceError` (`WorkspaceNameInvalidError`).
 * The 4xx-equivalent subclasses (id validation, name validation,
 * conflicts, not-registered) and the 5xx-equivalent `RegistryError`
 * itself are all exported so the HTTP layer can map them to status
 * codes downstream.
 */
export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

/** Display name is empty, too long, or contains control chars. */
export class WorkspaceNameInvalidError extends WorkspaceError {
  override readonly name = "WorkspaceNameInvalidError";

  constructor(
    public readonly displayName: string,
    public readonly reason: string,
  ) {
    super(`invalid workspace display name "${displayName}": ${reason}`);
  }
}

/** Base for all registry-related errors. */
export class RegistryError extends WorkspaceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryError";
  }
}

export class WorkspaceIdConflictError extends RegistryError {
  override readonly name = "WorkspaceIdConflictError";

  constructor(public readonly workspaceId: string) {
    super(`a workspace with id "${workspaceId}" is already registered`);
  }
}

export class WorkspaceIdInvalidError extends RegistryError {
  override readonly name = "WorkspaceIdInvalidError";

  constructor(public readonly workspaceId: string) {
    super(`workspace id "${workspaceId}" is not a valid UUID`);
  }
}

export class WorkspacePathConflictError extends RegistryError {
  override readonly name = "WorkspacePathConflictError";

  constructor(
    public readonly path: string,
    public readonly existingId: string,
  ) {
    super(`path ${path} is already registered as workspace id "${existingId}"`);
  }
}

export class WorkspaceNotRegisteredError extends RegistryError {
  override readonly name = "WorkspaceNotRegisteredError";

  constructor(public readonly workspaceId: string) {
    super(`no workspace with id "${workspaceId}" is registered`);
  }
}

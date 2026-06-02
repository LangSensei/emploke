/**
 * Error hierarchy for `@emploke/workspace`. Every public throw extends
 * `WorkspaceError` so callers can `instanceof WorkspaceError` for a
 * coarse "is this from workspace?" check; specific subclasses below
 * carry typed context (the offending id / name / path).
 *
 * `RegistryError` is a sub-base for everything that originates in the
 * registry table (id / path conflicts, missing rows). Both the 4xx-equivalent
 * subclasses (validation, conflict, not-registered) and the 5xx-equivalent
 * `RegistryError` itself are exported because the HTTP layer maps them
 * to status codes downstream.
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

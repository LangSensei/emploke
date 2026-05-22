/**
 * Base error class for everything thrown by `@emploke/workspace`. Callers
 * who only need a coarse "is this from workspace?" check can `instanceof`
 * this; specific subclasses below carry richer typed context.
 *
 * Surface intentionally narrow — only errors actually constructed by
 * `WorkspaceService` and its repository live here. Earlier
 * iterations exported defensive `*NotFound` / `*Corrupted` /
 * `Registry*` subclasses for cases that never materialised in the
 * de-DDD codebase; trimmed when a code-review pass flagged them as
 * dead exports.
 */
export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
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
  constructor(message: string, options?: { cause?: unknown }) {
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

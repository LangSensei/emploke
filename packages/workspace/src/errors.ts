/**
 * Base error class for everything thrown by `@emploke/workspace`. Callers
 * who only need a coarse "is this from workspace?" check can `instanceof`
 * this; specific subclasses below carry richer typed context.
 */
export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "WorkspaceError";
  }
}

/** Lookup against the registry could not find the workspace. */
export class WorkspaceNotFoundError extends WorkspaceError {
  override readonly name = "WorkspaceNotFoundError";

  constructor(public readonly dir: string) {
    super(`workspace not found at ${dir}`);
  }
}

/** A row in `global.db.workspaces` failed validation. */
export class WorkspaceCorruptedError extends WorkspaceError {
  override readonly name = "WorkspaceCorruptedError";

  constructor(
    public readonly dir: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`workspace row at ${dir} is corrupted: ${reason}`, options);
  }
}

function schemaDirectionHint(fromVersion: number, toVersion: number): string {
  if (fromVersion > toVersion) {
    return "Upgrade the server to read it (downgrading is unsafe).";
  }
  if (fromVersion < toVersion) {
    return "Migration from older versions is not yet implemented.";
  }
  return "";
}

/** `register` refused to overwrite an existing workspace. */
export class WorkspaceAlreadyExistsError extends WorkspaceError {
  override readonly name = "WorkspaceAlreadyExistsError";

  constructor(public readonly dir: string) {
    super(`workspace already initialised at ${dir}`);
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

export class RegistryCorruptedError extends RegistryError {
  override readonly name = "RegistryCorruptedError";

  constructor(
    public readonly file: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`workspace registry at ${file} is corrupted: ${reason}`, options);
  }
}

export class RegistrySchemaMismatchError extends RegistryError {
  override readonly name = "RegistrySchemaMismatchError";

  constructor(
    public readonly file: string,
    public readonly fromVersion: number,
    public readonly toVersion: number,
  ) {
    super(
      `workspace registry at ${file} has schemaVersion ${fromVersion}; this server supports ${toVersion}. ${schemaDirectionHint(fromVersion, toVersion)}`,
    );
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

export class RegistryNotBootstrappedError extends RegistryError {
  override readonly name = "RegistryNotBootstrappedError";

  constructor(public readonly file: string) {
    super(
      `workspace registry at ${file} has no MikroORM schema yet — call composeWorkspaceModule({dbFile}) once before consuming the registry.`,
    );
  }
}

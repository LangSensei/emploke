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
  constructor(public readonly dir: string) {
    super(`workspace not found at ${dir}`);
    this.name = "WorkspaceNotFoundError";
  }
}

/** A row in `global.db.workspaces` failed validation. */
export class WorkspaceCorruptedError extends WorkspaceError {
  constructor(
    public readonly dir: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`workspace row at ${dir} is corrupted: ${reason}`, options);
    this.name = "WorkspaceCorruptedError";
  }
}

/**
 * Operator-actionable hint based on the direction of the mismatch.
 * Newer-on-disk = upgrade the server; older-on-disk = needs a migration
 * (which is not implemented yet).
 */
function schemaDirectionHint(fromVersion: number, toVersion: number): string {
  if (fromVersion > toVersion) {
    return "Upgrade the server to read it (downgrading is unsafe).";
  }
  if (fromVersion < toVersion) {
    return "Migration from older versions is not yet implemented.";
  }
  return "";
}

/** `RegisterWorkspaceCommand` refused to overwrite an existing workspace. */
export class WorkspaceAlreadyExistsError extends WorkspaceError {
  constructor(public readonly dir: string) {
    super(`workspace already initialised at ${dir}`);
    this.name = "WorkspaceAlreadyExistsError";
  }
}

/** Display name is empty, too long, or contains control chars. */
export class WorkspaceNameInvalidError extends WorkspaceError {
  constructor(
    public readonly displayName: string,
    public readonly reason: string,
  ) {
    super(`invalid workspace display name "${displayName}": ${reason}`);
    this.name = "WorkspaceNameInvalidError";
  }
}

/** Base for all registry-related errors. */
export class RegistryError extends WorkspaceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RegistryError";
  }
}

/** `global.db.workspaces` row failed validation or schema drift. */
export class RegistryCorruptedError extends RegistryError {
  constructor(
    public readonly file: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`workspace registry at ${file} is corrupted: ${reason}`, options);
    this.name = "RegistryCorruptedError";
  }
}

/**
 * The workspace pkg's row in `global.db.schema_meta` declares a
 * version this build doesn't understand.
 */
export class RegistrySchemaMismatchError extends RegistryError {
  constructor(
    public readonly file: string,
    public readonly fromVersion: number,
    public readonly toVersion: number,
  ) {
    super(
      `workspace registry at ${file} has schemaVersion ${fromVersion}; this server supports ${toVersion}. ${schemaDirectionHint(fromVersion, toVersion)}`,
    );
    this.name = "RegistrySchemaMismatchError";
  }
}

/** A workspace with the same id is already registered. */
export class WorkspaceIdConflictError extends RegistryError {
  constructor(public readonly workspaceId: string) {
    super(`a workspace with id "${workspaceId}" is already registered`);
    this.name = "WorkspaceIdConflictError";
  }
}

/** An explicit id that doesn't match the UUID format we accept. */
export class WorkspaceIdInvalidError extends RegistryError {
  constructor(public readonly workspaceId: string) {
    super(`workspace id "${workspaceId}" is not a valid UUID`);
    this.name = "WorkspaceIdInvalidError";
  }
}

/** A workspace whose path conflicts with an existing entry. */
export class WorkspacePathConflictError extends RegistryError {
  constructor(
    public readonly path: string,
    public readonly existingId: string,
  ) {
    super(`path ${path} is already registered as workspace id "${existingId}"`);
    this.name = "WorkspacePathConflictError";
  }
}

/** Tried to look up / remove / set-current a workspace not in the registry. */
export class WorkspaceNotRegisteredError extends RegistryError {
  constructor(public readonly workspaceId: string) {
    super(`no workspace with id "${workspaceId}" is registered`);
    this.name = "WorkspaceNotRegisteredError";
  }
}

/**
 * The repository was constructed against a DB that has no `schema_meta`
 * row for the `workspace` pkg. Always a wiring bug — the
 * MigrationCoordinator must run before the repository is constructed.
 */
export class RegistryNotBootstrappedError extends RegistryError {
  constructor(public readonly file: string) {
    super(
      `workspace registry at ${file} has no schema_meta entry for pkg 'workspace'. ` +
        `MigrationCoordinator must run before SqliteWorkspaceRepository is constructed.`,
    );
    this.name = "RegistryNotBootstrappedError";
  }
}

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

/** `WorkspaceManager.open()` could not find or read `workspace.json`. */
export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(public readonly dir: string) {
    super(`workspace.json not found at ${dir}`);
    this.name = "WorkspaceNotFoundError";
  }
}

/** `workspace.json` exists but cannot be parsed or violates the schema. */
export class WorkspaceCorruptedError extends WorkspaceError {
  constructor(
    public readonly dir: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`workspace.json at ${dir} is corrupted: ${reason}`, options);
    this.name = "WorkspaceCorruptedError";
  }
}

/** `workspace.json` declares a schemaVersion this build doesn't understand. */
export class WorkspaceSchemaMismatchError extends WorkspaceError {
  constructor(
    public readonly dir: string,
    public readonly fromVersion: number,
    public readonly toVersion: number,
  ) {
    super(`workspace.json at ${dir} has schemaVersion ${fromVersion}; expected ${toVersion}`);
    this.name = "WorkspaceSchemaMismatchError";
  }
}

/** `WorkspaceManager.init()` refused to overwrite an existing workspace. */
export class WorkspaceAlreadyExistsError extends WorkspaceError {
  constructor(public readonly dir: string) {
    super(`workspace already initialised at ${dir}`);
    this.name = "WorkspaceAlreadyExistsError";
  }
}

/** Display name (metadata.name) is empty, too long, or contains control chars. */
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

/** `workspaces.json` exists but cannot be parsed or violates the schema. */
export class RegistryCorruptedError extends RegistryError {
  constructor(
    public readonly file: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`workspaces.json at ${file} is corrupted: ${reason}`, options);
    this.name = "RegistryCorruptedError";
  }
}

/**
 * Tried to add a workspace whose id collides with an existing entry. With
 * UUID generation this is statistically impossible  but the registry
 * still guards against it because callers may supply explicit ids in
 * tests or future migrations.
 */
export class WorkspaceIdConflictError extends RegistryError {
  constructor(public readonly workspaceId: string) {
    super(`a workspace with id "${workspaceId}" is already registered`);
    this.name = "WorkspaceIdConflictError";
  }
}

/** Tried to add a workspace whose path conflicts with an existing entry. */
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

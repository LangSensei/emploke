/**
 * Error hierarchy for @emploke/catalog.
 *
 * All errors extend {@link CatalogError} so consumers can `catch (e)` then
 * narrow with `instanceof`. emploke does not throw bare Error objects from
 * its public API.
 */

export class CatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

export class NameInvalid extends CatalogError {
  constructor(
    public readonly invalidName: string,
    public readonly reason: string,
  ) {
    super(`invalid name "${invalidName}": ${reason}`);
  }
}

export class NameConflict extends CatalogError {
  constructor(public readonly conflictingName: string) {
    super(`name already exists in catalog: "${conflictingName}"`);
  }
}

export class MissingDependencies extends CatalogError {
  constructor(public readonly missing: readonly string[]) {
    super(`missing dependencies: ${missing.join(", ")}`);
  }
}

export class CycleDetected extends CatalogError {
  constructor(public readonly cycle: readonly string[]) {
    super(`dependency cycle detected: ${cycle.join(" → ")}`);
  }
}

export class HasDependents extends CatalogError {
  constructor(
    public readonly target: string,
    public readonly dependents: readonly string[],
  ) {
    super(`cannot remove "${target}": still depended on by [${dependents.join(", ")}]`);
  }
}

export class NotFound extends CatalogError {
  constructor(
    public readonly kind: "skill" | "agent" | "mcp",
    public readonly missingName: string,
  ) {
    super(`${kind} not found: "${missingName}"`);
  }
}

export class FrontmatterError extends CatalogError {
  constructor(
    public readonly path: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`frontmatter parse failed at ${path}: ${reason}`, options);
  }
}

/** Catalog used in an inconsistent way (e.g. methods called before open()). */
export class CatalogStateError extends CatalogError {}

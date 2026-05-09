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

/**
 * MCP-specific name validation failure. Distinct from {@link NameInvalid}
 * (which enforces the strict skill/agent kebab grammar) because MCP
 * names follow the looser MCP-spec shape (`<namespace>/<short>`,
 * one slash, non-empty halves) — a publisher's `azure/mcp` would fail
 * the kebab check but is a perfectly valid MCP identifier per spec.
 */
export class McpNameInvalidError extends CatalogError {
  constructor(
    public readonly invalidName: string,
    public readonly reason: string,
  ) {
    super(`invalid MCP name "${invalidName}": ${reason}`);
  }
}

export class CycleDetected extends CatalogError {
  constructor(public readonly cycle: readonly string[]) {
    super(`dependency cycle detected: ${cycle.join(" → ")}`);
  }
}

export class MissingDependencies extends CatalogError {
  constructor(public readonly missing: readonly string[]) {
    super(`missing dependencies: ${missing.join(", ")}`);
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

/**
 * Attempted to install an entry whose computed FQN (`scope/name`) is already
 * occupied by an entry with a different (normalized) origin. The install is
 * refused rather than silently overwriting, so an upstream skill cannot be
 * shadowed by a malicious fork sharing its short name.
 *
 * Resolution: uninstall the existing entry first, or (if the user genuinely
 * wants the fork) install it under a different scope by setting an explicit
 * `scope:` field in the source frontmatter.
 */
export class OriginConflictError extends CatalogError {
  constructor(
    public readonly fqn: string,
    public readonly existingOrigin: string,
    public readonly incomingOrigin: string,
  ) {
    super(
      `origin conflict for "${fqn}": already installed from "${existingOrigin}", refused install from "${incomingOrigin}". Uninstall the existing entry to swap origins.`,
    );
  }
}

/**
 * Loaded `catalog.json` carries a `version` field that this build of
 * emploke doesn't recognise. Refused at boot rather than continuing
 * with potentially incompatible data — losing scope mappings or
 * silently corrupting catalog config would be much worse than a loud
 * crash.
 */
export class UnsupportedCatalogVersionError extends CatalogError {
  constructor(
    public readonly path: string,
    public readonly foundVersion: unknown,
    public readonly expectedVersion: number,
  ) {
    super(
      `unsupported catalog.json version ${JSON.stringify(foundVersion)} at ${path}; this build expects version ${expectedVersion}`,
    );
  }
}

/**
 * Invalid MCP file content (raw JSON parse failure or missing required
 * keys). Distinct from {@link FrontmatterError} so the route layer can
 * map it to a more specific 400 message.
 */
export class InvalidMcpJsonError extends CatalogError {
  constructor(
    public readonly path: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`invalid MCP JSON at ${path}: ${reason}`, options);
  }
}

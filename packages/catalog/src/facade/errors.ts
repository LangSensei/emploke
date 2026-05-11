/**
 * Cross-entity catalog errors. Errors that originate inside a single
 * entity service (skill / agent / mcp) propagate as-is; this file
 * only declares errors specific to facade-level concerns.
 */

abstract class CatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/**
 * Thrown when deleting an entity that other entities still depend on.
 * The facade detects this by scanning all skills/agents for refs to
 * the target name.
 */
export class HasDependentsError extends CatalogError {
  constructor(
    public readonly targetName: string,
    public readonly dependents: readonly { kind: "skill" | "agent"; name: string }[],
  ) {
    super(
      `cannot delete "${targetName}" — still referenced by ${dependents
        .map((d) => `${d.kind} ${d.name}`)
        .join(", ")}`,
    );
  }
}

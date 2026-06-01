/**
 * Cross-entity catalog errors. Errors that originate inside a single
 * entity service (skill / agent / mcp) propagate as-is; this file
 * only declares errors specific to facade-level concerns.
 *
 * Extends native `Error` directly — no shared abstract base.
 */

/**
 * Thrown when deleting an entity that other entities still depend on.
 * The facade detects this by scanning all skills/agents for refs to
 * the target name.
 */
export class HasDependentsError extends Error {
  override readonly name = "HasDependentsError";

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

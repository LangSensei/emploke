/**
 * Skill-specific error types. All errors extend native `Error` with a
 * stable `name` field so HTTP transport layers can map them to status
 * codes without instanceof imports across package boundaries.
 *
 * No shared abstract base — each class sets `name` in its own field
 * initialiser.
 */

/** Thrown when a skill name (FQN, scope, or short name) violates format rules. */
export class SkillNameInvalidError extends Error {
  override readonly name = "SkillNameInvalidError";

  constructor(
    public readonly skillName: string,
    reason: string,
  ) {
    super(`invalid skill name "${skillName}": ${reason}`);
  }
}

/** Thrown when looking up a skill that doesn't exist. */
export class SkillNotFoundError extends Error {
  override readonly name = "SkillNotFoundError";

  constructor(public readonly skillName: string) {
    super(`skill not found: ${skillName}`);
  }
}

/**
 * Thrown when reinstalling an existing skill under a different origin.
 * Identity (FQN) collisions across origins are rejected — to switch
 * origins, the caller must explicitly delete then reinstall.
 */
export class SkillOriginConflictError extends Error {
  override readonly name = "SkillOriginConflictError";

  constructor(
    public readonly skillName: string,
    public readonly existingOrigin: string,
    public readonly attemptedOrigin: string,
  ) {
    super(
      `skill "${skillName}" is already installed from "${existingOrigin}"; ` +
        `refusing to overwrite with origin "${attemptedOrigin}". ` +
        "Delete and reinstall to switch origins.",
    );
  }
}

/**
 * Thrown when SKILL.md frontmatter can't be parsed or violates the
 * schema (missing required fields, wrong types, malformed deps, ...).
 */
export class SkillFrontmatterError extends Error {
  override readonly name = "SkillFrontmatterError";

  constructor(
    public readonly sourceLabel: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`invalid SKILL.md frontmatter (${sourceLabel}): ${reason}`, options as ErrorOptions);
  }
}

/**
 * Thrown by the resolve walker when the upstream skill graph contains
 * a back-edge — i.e. some skill transitively depends on itself.
 * Emploke does not support cyclic catalog deps; the user must break
 * the cycle in the upstream frontmatter.
 *
 * Why we reject at install/sync time rather than tolerate at runtime:
 * the cascade-status pass (`computeSkillStatus` in the facade) uses
 * recursive memoisation to compute "this entry is blocked because its
 * dep is blocked". With cycles, the inner recursive call sees the
 * outer node mid-computation and has to short-circuit — but caching
 * that short-circuited result poisons downstream callers that asked
 * from outside the cycle. Refusing cycles up-front is cheaper than
 * handling that correctly.
 *
 * `cycle` is the back-edge path from the cycle's entry point through
 * to the offending repeat: e.g. `[fileA, fileB, fileA]` means fileA
 * depends on fileB which depends on fileA. Origins (not fqns) are
 * used because the back-edge may be detected before the upstream
 * anchor at the repeat origin has been parsed (so its fqn isn't
 * known at throw time).
 */
export class CyclicDependencyError extends Error {
  override readonly name = "CyclicDependencyError";

  constructor(public readonly cycle: readonly string[]) {
    super(
      `circular skill dependency detected: ${cycle.join(" → ")}. ` +
        "Emploke does not support cyclic catalog deps; break the cycle by " +
        "removing one of the dep refs in the upstream frontmatter and re-installing.",
    );
  }
}

/**
 * Thrown by `install` when the resolve plan is stale — i.e. the
 * upstream anchor's `version` changed between resolve and install.
 * Caller should re-resolve before retrying.
 *
 * Why version? Emploke's authoring contract says any meaningful
 * change to SKILL.md MUST bump `version`; without a bump we treat
 * the file as unchanged. Using version (not a byte hash) keeps the
 * detection in the contract's own vocabulary — a contributor who
 * edited the file without bumping is, by contract, not making a
 * change emploke needs to react to.
 */
export class PlanStaleError extends Error {
  override readonly name = "PlanStaleError";

  constructor(
    public readonly skillName: string,
    public readonly origin: string,
    public readonly expectedVersion: string,
    public readonly actualVersion: string,
  ) {
    super(
      `plan stale for "${skillName}" @ ${origin}: ` +
        `version changed from ${expectedVersion} to ${actualVersion}. ` +
        "Re-resolve before installing.",
    );
  }
}

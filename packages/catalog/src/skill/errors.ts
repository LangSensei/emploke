/**
 * Skill-specific error types. All errors in this package extend `Error`
 * with a stable `name` so HTTP transport layers can map them to status
 * codes without instanceof imports.
 */

abstract class SkillError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/** Thrown when a skill name (FQN, scope, or short name) violates format rules. */
export class SkillNameInvalidError extends SkillError {
  constructor(
    public readonly skillName: string,
    reason: string,
  ) {
    super(`invalid skill name "${skillName}": ${reason}`);
  }
}

/** Thrown when looking up a skill that doesn't exist. */
export class SkillNotFoundError extends SkillError {
  constructor(public readonly skillName: string) {
    super(`skill not found: ${skillName}`);
  }
}

/**
 * Thrown when reinstalling an existing skill under a different origin.
 * Identity (FQN) collisions across origins are rejected — to switch
 * origins, the caller must explicitly delete then reinstall.
 */
export class SkillOriginConflictError extends SkillError {
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
export class SkillFrontmatterError extends SkillError {
  constructor(
    public readonly sourceLabel: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`invalid SKILL.md frontmatter (${sourceLabel}): ${reason}`, options);
  }
}

/**
 * Thrown by `install` when the resolve plan is stale — i.e. the
 * upstream anchor's SHA-256 changed between resolve and install.
 * Caller should re-resolve before retrying.
 */
export class PlanStaleError extends SkillError {
  constructor(
    public readonly skillName: string,
    public readonly origin: string,
    public readonly expectedSha: string,
    public readonly actualSha: string,
  ) {
    super(
      `plan stale for "${skillName}" @ ${origin}: ` +
        `anchor SHA changed from ${expectedSha.slice(0, 12)} to ${actualSha.slice(0, 12)}. ` +
        "Re-resolve before installing.",
    );
  }
}

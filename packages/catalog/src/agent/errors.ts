/**
 * Agent-specific error types. All errors in this package extend `Error`
 * with a stable `name` so HTTP transport layers can map them to status
 * codes without instanceof imports.
 */

abstract class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/** Thrown when an agent name (FQN, scope, or short name) violates format rules. */
export class AgentNameInvalidError extends AgentError {
  constructor(
    public readonly agentName: string,
    reason: string,
  ) {
    super(`invalid agent name "${agentName}": ${reason}`);
  }
}

/** Thrown when looking up an agent that doesn't exist. */
export class AgentNotFoundError extends AgentError {
  constructor(public readonly agentName: string) {
    super(`agent not found: ${agentName}`);
  }
}

/**
 * Thrown when reinstalling an existing agent under a different origin.
 * Identity (FQN) collisions across origins are rejected — to switch
 * origins, the caller must explicitly delete then reinstall.
 */
export class AgentOriginConflictError extends AgentError {
  constructor(
    public readonly agentName: string,
    public readonly existingOrigin: string,
    public readonly attemptedOrigin: string,
  ) {
    super(
      `agent "${agentName}" is already installed from "${existingOrigin}"; ` +
        `refusing to overwrite with origin "${attemptedOrigin}". ` +
        "Delete and reinstall to switch origins.",
    );
  }
}

/**
 * Thrown when AGENTS.md frontmatter can't be parsed or violates the
 * schema (missing required fields, wrong types, malformed deps, ...).
 */
export class AgentFrontmatterError extends AgentError {
  constructor(
    public readonly sourceLabel: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`invalid AGENTS.md frontmatter (${sourceLabel}): ${reason}`, options);
  }
}

/**
 * Thrown by `install` when the resolve plan is stale — i.e. the
 * upstream anchor's `version` changed between resolve and install.
 * Caller should re-resolve before retrying. See {@link
 * PlanStaleError} (skill counterpart) for the version-not-hash
 * rationale.
 */
export class AgentPlanStaleError extends AgentError {
  constructor(
    public readonly agentName: string,
    public readonly origin: string,
    public readonly expectedVersion: string,
    public readonly actualVersion: string,
  ) {
    super(
      `plan stale for agent "${agentName}" @ ${origin}: ` +
        `version changed from ${expectedVersion} to ${actualVersion}. ` +
        "Re-resolve before installing.",
    );
  }
}

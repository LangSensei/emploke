/**
 * Errors thrown by the sessions package. All are subclasses of Error with
 * stable `name` strings so callers can branch by `e.name` without instanceof
 * checks across realms.
 */

export class SessionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionsError";
  }
}

/** A session ID supplied by a caller did not match the canonical format. */
export class InvalidSessionIdError extends SessionsError {
  constructor(public readonly id: string) {
    super(`invalid session id: ${JSON.stringify(id)} (expected YYYYMMDD-HHMMSS-xxxxxxxx)`);
    this.name = "InvalidSessionIdError";
  }
}

/** No session exists with the given id. */
export class SessionNotFoundError extends SessionsError {
  constructor(public readonly id: string) {
    super(`session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

/** Repeated id collisions during create() (vanishingly unlikely under normal use). */
export class SessionAlreadyExistsError extends SessionsError {
  constructor(public readonly id: string) {
    super(`session already exists: ${id} (after retries)`);
    this.name = "SessionAlreadyExistsError";
  }
}

/** create() called with an agent name not present in the catalog. */
export class AgentNotFoundError extends SessionsError {
  constructor(
    public readonly agent: string,
    cause?: Error,
  ) {
    super(`agent not found in catalog: ${agent}${cause ? ` (${cause.message})` : ""}`);
    this.name = "AgentNotFoundError";
    if (cause) this.cause = cause;
  }
}

/** Caller-supplied Copilot session id failed format/scope validation. */
export class InvalidCopilotSessionIdError extends SessionsError {
  constructor(public readonly id: string) {
    super(`invalid copilot session id: ${JSON.stringify(id)} (expected UUID)`);
    this.name = "InvalidCopilotSessionIdError";
  }
}

/** A Copilot session id was valid but does not belong to the given emploke session. */
export class CopilotSessionNotFoundError extends SessionsError {
  constructor(
    public readonly sessionId: string,
    public readonly copilotSessionId: string,
  ) {
    super(
      `copilot session ${copilotSessionId} is not associated with emploke session ${sessionId}`,
    );
    this.name = "CopilotSessionNotFoundError";
  }
}

/** delete({ deleteCopilotState: true }) failed to remove some Copilot session dirs. */
export class CopilotStateDeletionFailed extends SessionsError {
  constructor(
    public readonly sessionId: string,
    public readonly failures: ReadonlyArray<{ copilotSessionId: string; reason: string }>,
  ) {
    const summary = failures.map((f) => `${f.copilotSessionId}: ${f.reason}`).join("; ");
    super(`failed to delete copilot state for ${sessionId}: ${summary}`);
    this.name = "CopilotStateDeletionFailed";
  }
}

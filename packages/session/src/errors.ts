/**
 * Errors thrown by the sessions package. All have stable `name` strings so
 * callers can branch by `e.name` without instanceof checks across realms.
 *
 * Runtime-level errors (UnknownRuntimeError, RuntimeRefreshFailed,
 * RuntimeStateDeletionFailed, RuntimeProvisionFailed) are imported directly
 * from `@emploke/runtime` — they are not re-wrapped here so callers can
 * distinguish "runtime adapter failed" from "session-layer logic failed".
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
    super(`invalid session id: ${JSON.stringify(id)} (expected YYYYMMDD-xxxxxxxx)`);
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

/**
 * The workdir exists but its `session.json` is missing, malformed, or
 * declares an unsupported `schemaVersion`. Surfaced by list()/get() — they
 * skip and warn — and by delete() — which throws so the user can investigate.
 */
export class SessionCorruptedError extends SessionsError {
  constructor(
    public readonly id: string,
    public readonly reason: string,
  ) {
    super(`session ${id} is corrupted: ${reason}`);
    this.name = "SessionCorruptedError";
  }
}

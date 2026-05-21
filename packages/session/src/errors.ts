/**
 * Errors thrown by the sessions package. All have stable `name` strings so
 * callers can branch by `e.name` without instanceof checks across realms.
 *
 * Runtime-level errors (UnknownRuntimeError, RuntimeRefreshFailed,
 * RuntimeStateDeletionFailed, RuntimeProvisionFailed) are imported directly
 * from `@emploke/runtime` — they are not re-wrapped here so callers can
 * distinguish "runtime adapter failed" from "session-layer logic failed".
 */

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

/** A session ID supplied by a caller did not match the canonical format. */
export class InvalidSessionIdError extends SessionError {
  override readonly name = "InvalidSessionIdError";

  constructor(public readonly id: string) {
    super(`invalid session id: ${JSON.stringify(id)} (expected YYYYMMDD-xxxxxxxx)`);
  }
}

/** No session exists with the given id. */
export class SessionNotFoundError extends SessionError {
  override readonly name = "SessionNotFoundError";

  constructor(public readonly id: string) {
    super(`session not found: ${id}`);
  }
}

/** Repeated id-allocation collisions during create() (vanishingly unlikely
 * under normal use; usually indicates a stuck clock or broken RNG). */
export class SessionIdAllocationFailedError extends SessionError {
  override readonly name = "SessionIdAllocationFailedError";

  constructor(public readonly attempts: number) {
    super(
      `failed to allocate a unique session id after ${attempts} attempts ` +
        `(check the system clock and randomness source)`,
    );
  }
}

/** create() called with an agent name not present in the catalog. */
export class AgentNotFoundError extends SessionError {
  override readonly name = "AgentNotFoundError";

  constructor(
    public readonly agent: string,
    cause?: Error,
  ) {
    super(`agent not found in catalog: ${agent}${cause ? ` (${cause.message})` : ""}`);
    if (cause) this.cause = cause;
  }
}

/**
 * The persisted session row is missing required fields, holds an
 * invalid value, or has a column shape the current build cannot
 * decode. Surfaced by `list()` / `get()` — they skip and warn — and
 * by `delete()` — which throws so the user can investigate.
 *
 * Carries the offending session `id` plus a human-readable `reason`
 * so operators can find the bad row in the workspace's `sessions`
 * table without re-running the failing query.
 */
export class SessionCorruptedError extends SessionError {
  override readonly name = "SessionCorruptedError";

  constructor(
    public readonly id: string,
    public readonly reason: string,
  ) {
    super(`session ${id} is corrupted: ${reason}`);
  }
}

/**
 * Thrown when a `Session.runtime` value names a runtime that hasn't been
 * registered in the active `RuntimeRegistry`. Typically indicates a
 * configuration mismatch between the server and the on-disk session records
 * (e.g. session was created with a runtime that has since been removed).
 */
export class UnknownRuntimeError extends Error {
  constructor(public readonly kind: string) {
    super(`unknown runtime: ${JSON.stringify(kind)}`);
    this.name = "UnknownRuntimeError";
  }
}

/**
 * Wraps a failure that happened inside `Runtime.refresh`. The original cause
 * is attached as `this.cause` per ES2022 conventions.
 *
 * The user-facing `.message` intentionally carries only the runtime kind —
 * not `sessionId` or the underlying `cause.message`. The kind is sufficient
 * for a UI surface ("Copilot session refresh failed; check server logs"),
 * while the path / fs error string would leak host paths and Node `fs`
 * codes through the JSON response (see issue #24). Operators can still
 * recover the full diagnostic via `err.sessionId`, `err.cause`, and the
 * server-side `console.error` log emitted at the route boundary.
 */
export class RuntimeRefreshFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly sessionId: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" refresh failed`);
    this.name = "RuntimeRefreshFailed";
    this.cause = cause;
  }
}

/**
 * Wraps a failure that happened inside `Runtime.deleteState`. The original
 * cause is attached as `this.cause`.
 *
 * `.message` carries only the runtime kind. See `RuntimeRefreshFailed` for
 * the rationale (issue #24).
 */
export class RuntimeStateDeletionFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly sessionId: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" deleteState failed`);
    this.name = "RuntimeStateDeletionFailed";
    this.cause = cause;
  }
}

/**
 * Wraps a failure that happened inside `Runtime.provision`.
 *
 * `.message` carries only the runtime kind. The workdir + cause stay on
 * the instance (`err.workdir`, `err.cause`) for server-side logging but
 * are kept out of the wire string. See `RuntimeRefreshFailed` (issue #24).
 */
export class RuntimeProvisionFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly workdir: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" provision failed`);
    this.name = "RuntimeProvisionFailed";
    this.cause = cause;
  }
}

/**
 * Wraps a failure that happened inside `Runtime.dispatchTask`. Covers
 * both pre-spawn errors (provisioning, mkdir on the runtime's session dir)
 * and spawn-itself errors (binary not found, exec permission denied,
 * platform refused to start the process).
 *
 * Once the subprocess is up, exit-time failures are surfaced via the
 * returned `TaskHandle.exit` instead — that's a normal task outcome, not
 * a dispatch failure.
 *
 * `.message` carries only the runtime kind. See `RuntimeRefreshFailed`
 * (issue #24).
 */
export class RuntimeDispatchTaskFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly taskDir: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" dispatchTask failed`);
    this.name = "RuntimeDispatchTaskFailed";
    this.cause = cause;
  }
}

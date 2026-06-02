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
 * Wraps a failure that happened inside `Runtime.readMetadata`. The original
 * cause is attached as `this.cause` per ES2022 conventions.
 *
 * The user-facing `.message` intentionally carries only the runtime kind —
 * not `sessionId` or the underlying `cause.message`. The kind is sufficient
 * for a UI surface ("Copilot session refresh failed; check server logs"),
 * while the path / fs error string would leak host paths and Node `fs`
 * codes through the JSON response. Operators can still recover the full
 * diagnostic via `err.sessionId`, `err.cause`, and the server-side
 * `console.error` log emitted at the route boundary.
 *
 * Class name is pinned to `RuntimeRefreshFailed` (rather than
 * `RuntimeReadMetadataFailed`) because consumers in the dashboard
 * error-toast registry pattern-match on `instanceof
 * RuntimeRefreshFailed`; the actual call site is
 * `CopilotRuntime.readMetadata`. The `.message` and `.name` carry
 * "refresh failed" for the same `instanceof`-adjacent reason.
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
 * the same rationale (don't leak host paths through the wire string).
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
 * are kept out of the wire string. See `RuntimeRefreshFailed` for the
 * same rationale.
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
 * Wraps a failure that happened inside `Runtime.launchHeadless`. Covers
 * both pre-spawn errors (provisioning, mkdir on the runtime's session dir)
 * and spawn-itself errors (binary not found, exec permission denied,
 * platform refused to start the process).
 *
 * Once the subprocess is up, exit-time failures are surfaced via the
 * returned `TaskHandle.exit` instead — that's a normal task outcome, not
 * a headless-launch failure.
 *
 * `.message` carries only the runtime kind. See `RuntimeRefreshFailed` for
 * the same rationale.
 */
export class RuntimeHeadlessLaunchFailed extends Error {
  constructor(
    public readonly kind: string,
    public readonly taskDir: string,
    cause: Error,
  ) {
    super(`runtime "${kind}" launchHeadless failed`);
    this.name = "RuntimeHeadlessLaunchFailed";
    this.cause = cause;
  }
}

/**
 * Thrown by `Runtime.buildInteractiveLaunch` when called with `{ remote: true }`
 * against a runtime that does NOT advertise
 * `capabilities.remoteSession === true`.
 *
 * The dashboard already gates the "Spawn remote" button by capabilities
 * so this error only fires when something bypasses that gate (a
 * hand-rolled curl, a future CLI / MCP caller, a stale dashboard tab
 * after a runtime swap). Mapping to HTTP 400 lets the caller correct
 * the request without retry.
 *
 * The kind is the only public field — `.message` says exactly which
 * runtime refused so the client can surface the correct UI hint
 * without echoing internal state. No path / cause is involved.
 */
export class RuntimeDoesNotSupportRemoteError extends Error {
  constructor(public readonly kind: string) {
    super(`runtime "${kind}" does not support remote sessions`);
    this.name = "RuntimeDoesNotSupportRemoteError";
  }
}

/**
 * Thrown by `Runtime.readActivity` when the caller violates the
 * `before` / `after` mutual-exclusion contract (e.g. supplies both,
 * or supplies a negative `limit`). The route layer should reject
 * such requests with HTTP 400 before reaching the runtime, so this
 * is purely a defensive guard against in-process callers that bypass
 * the route.
 *
 * `.message` carries the specific violation so logs are debuggable;
 * the route layer's 400 mapping uses the raw HTTP query rather than
 * forwarding this error's message.
 */
export class RuntimeReadActivityInvalidArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeReadActivityInvalidArgs";
  }
}

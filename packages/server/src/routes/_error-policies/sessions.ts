/**
 * Per-domain error policy for the sessions routes.
 *
 * Source of truth for the (class, status) pairs is the pre-refactor
 * private `statusForError` in `routes/sessions.ts`. Every entry below
 * was lifted byte-for-byte from that function.
 *
 * The session-package `AgentNotFoundError` is a distinct class from
 * the task / schedule / catalog variants of the same name; this
 * policy `instanceof`-matches the session-package class so the four
 * realm-specific status mappings stay independent (see the
 * commit-3 contract test).
 *
 * `AgentResolutionFailedError` carries a deliberately opaque
 * class-stable body — its `cause` may contain DB host paths, stack
 * frames, or other internals. The real diagnostics land in the
 * server log via `logFault()`; the wire response is collapsed to
 * `{ error: "internal error", code: "AgentResolutionFailedError" }`.
 */

import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  InvalidSessionIdError,
  RuntimeDoesNotSupportRemoteError,
  RuntimeProvisionFailed,
  RuntimeStateDeletionFailed,
  SessionIdAllocationFailedError,
  SessionNotFoundError,
  TrustRegistrationFailed,
  UnknownRuntimeError,
} from "@emploke/session";
import type { ErrorPolicy } from "../_respond-error.js";

const opaqueAgentResolutionBody = (_err: Error) => ({
  error: "internal error",
  code: "AgentResolutionFailedError",
});

export const sessionsErrorPolicy: ErrorPolicy = {
  name: "sessions",
  statuses: [
    [InvalidSessionIdError, 400],
    [SessionNotFoundError, 404],
    [AgentNotFoundError, 400],
    [AgentResolutionFailedError, 500, opaqueAgentResolutionBody],
    [UnknownRuntimeError, 400],
    [RuntimeDoesNotSupportRemoteError, 400],
    [RuntimeStateDeletionFailed, 409],
    [SessionIdAllocationFailedError, 500],
    [RuntimeProvisionFailed, 500],
    [TrustRegistrationFailed, 500],
  ],
};

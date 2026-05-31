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
 */

import {
  AgentNotFoundError,
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

export const sessionsErrorPolicy: ErrorPolicy = {
  name: "sessions",
  statuses: [
    [InvalidSessionIdError, 400],
    [SessionNotFoundError, 404],
    [AgentNotFoundError, 400],
    [UnknownRuntimeError, 400],
    [RuntimeDoesNotSupportRemoteError, 400],
    [RuntimeStateDeletionFailed, 409],
    [SessionIdAllocationFailedError, 500],
    [RuntimeProvisionFailed, 500],
    [TrustRegistrationFailed, 500],
  ],
};

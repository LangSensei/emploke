/**
 * Shared body builders for `_error-policies/*` entries — class-stable
 * response shapes that multiple policies need to return verbatim.
 *
 * Kept here, in the consumer directory, rather than inlined into
 * `_respond-error.ts` (the matcher engine) so the catalog of body
 * builders can grow without bloating the matcher. The underscore
 * prefix signals "internal to this directory"; there is no barrel
 * under `_error-policies/`, so importers reach in via explicit
 * filename.
 */

/**
 * `AgentResolutionFailedError` carries a deliberately opaque
 * class-stable body — its `cause` may contain DB host paths, stack
 * frames, or other internals. The real diagnostics land in the
 * server log via `logFault()`; the wire response is collapsed to
 * `{ error: "internal error", code: "AgentResolutionFailedError" }`
 * so dashboards can differentiate it from a generic 500 without
 * depending on the message.
 *
 * Used by the tasks / sessions / schedules policies (schedules wires
 * it for both the schedule-package and task-package classes). The
 * `_err` parameter is intentionally unused — the body is class-stable
 * and independent of the error instance — but kept in the signature
 * to satisfy the policy body-builder contract.
 */
export const opaqueAgentResolutionBody = (_err: Error) => ({
  error: "internal error",
  code: "AgentResolutionFailedError",
});

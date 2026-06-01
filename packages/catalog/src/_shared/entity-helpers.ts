/**
 * Tiny stateless helpers shared by the anchored kinds. Each helper is
 * one decision lifted out of the per-kind concrete class so the class
 * body reads as "compose helpers" rather than "interleave concerns".
 *
 * Keep this file ~50 LOC. If a helper grows past a handful of lines,
 * split it back into the calling kind.
 */

/** True iff `prereqs` is a non-empty, non-whitespace-only string. */
export function hasNonEmptyPrereqs(prereqs: string | undefined): boolean {
  return prereqs !== undefined && prereqs.trim().length > 0;
}

/**
 * Throw `TypeError` if `origin` is not a non-empty string. The label
 * is the class-method name used in the diagnostic
 * (e.g. `"AgentEntity.create"`).
 */
export function requireNonEmptyOrigin(origin: string, label: string): string {
  if (typeof origin !== "string" || origin.length === 0) {
    throw new TypeError(`${label} requires a non-empty origin string`);
  }
  return origin;
}

/**
 * Whether a freshly-created entity's `prereqsAck` defaults to true.
 * Rule: ack is implicitly true iff no meaningful prereqs are declared
 * (so the operator isn't blocked on an empty acknowledgement).
 */
export function initialPrereqsAck(prereqs: string | undefined): boolean {
  return !hasNonEmptyPrereqs(prereqs);
}

/** Single call site for `new Date().toISOString()`. */
export function nowIso(): string {
  return new Date().toISOString();
}

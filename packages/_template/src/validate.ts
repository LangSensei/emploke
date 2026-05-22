/**
 * Input validation for `@emploke/__PKG__`. ALL grammar/format checks
 * live here so repository, queries, service, and any HTTP boundary
 * share one source of truth. Pure functions; no I/O.
 *
 * Convention: validators THROW (`assertValidXxx`) so callers can use
 * TypeScript's `asserts ... is string` narrowing. Predicate-returning
 * versions are NOT exported — branch on the throw instead.
 */

import { Invalid__Entity__IdError } from "./errors.js";

/** Grammar for `__entity__.id`: 1–64 chars of [a-zA-Z0-9_-]. */
export const __ENTITY___ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Throw {@link Invalid__Entity__IdError} if `id` does not match the grammar. */
export function assertValid__Entity__Id(id: unknown): asserts id is string {
  if (typeof id !== "string" || !__ENTITY___ID_RE.test(id)) {
    throw new Invalid__Entity__IdError(String(id));
  }
}

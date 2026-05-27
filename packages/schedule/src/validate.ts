/**
 * Input validation for `@emploke/schedule`. Pure functions; no I/O.
 *
 * Convention: validators THROW (`assertValidXxx`) so callers can use
 * TypeScript's `asserts ... is string` narrowing.
 */

import { randomUUID } from "node:crypto";
import { InvalidScheduleIdError } from "./errors.js";

// UUID v4 — same shape as workspace ids, NOT the YYYYMMDD-xxxxxxxx form
// task/session/workflow use. RFC §"Id format": schedule has no FS workdir
// so the ls-grouping benefit doesn't apply.
export const SCHEDULE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertValidScheduleId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !SCHEDULE_ID_RE.test(id)) {
    throw new InvalidScheduleIdError(String(id));
  }
}

/**
 * UUID v4 generator with an injectable random-source seam (used by
 * tests to produce deterministic ids).
 */
export function generateScheduleId(randomUUIDFn: () => string = randomUUID): string {
  return randomUUIDFn();
}

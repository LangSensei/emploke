import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { InvalidSessionIdError } from "./errors.js";

/**
 * Canonical session id format: `YYYYMMDD-xxxxxxxx`
 *
 *   - YYYYMMDD: local-date prefix for at-a-glance grouping in `ls`
 *   - xxxxxxxx: 8 hex chars (4 random bytes), ~4B-id-per-day collision space
 *
 * The id is NOT a precise timestamp — within-day ordering comes from the
 * createdAt derived from the workdir's stat birthtime.
 */
export const SESSION_ID_RE = /^\d{8}-[0-9a-f]{8}$/;

/**
 * Validate a caller-provided id. Throws InvalidSessionIdError if it does not
 * match SESSION_ID_RE. Used as a defense-in-depth check before any FS path
 * is constructed from the id.
 */
export function assertValidSessionId(id: string): void {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
    throw new InvalidSessionIdError(id);
  }
}

/**
 * Generate a fresh session id using the supplied clock and random source.
 * Both are injectable for deterministic testing.
 */
export function generateSessionId(
  now: () => Date = () => new Date(),
  randomBytes: (n: number) => Buffer = cryptoRandomBytes,
): string {
  const d = now();
  const date = pad4(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate());
  const suffix = randomBytes(4).toString("hex");
  return `${date}-${suffix}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}

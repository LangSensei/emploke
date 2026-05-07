import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { InvalidSessionIdError } from "./errors.js";

/**
 * Canonical session id format: `YYYYMMDD-HHMMSS-xxxxxxxx`
 *
 *   - YYYYMMDD-HHMMSS: local-time timestamp with second precision
 *   - xxxxxxxx: 8 hex chars (4 random bytes), making collisions within the
 *     same second vanishingly unlikely (2^32 space)
 *
 * Matches swat operation ids.
 */
export const SESSION_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

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
  const ts =
    pad4(d.getFullYear()) +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    "-" +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds());
  const suffix = randomBytes(4).toString("hex");
  return `${ts}-${suffix}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}

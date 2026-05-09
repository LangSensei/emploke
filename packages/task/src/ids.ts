import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { InvalidTaskIdError } from "./errors.js";

/**
 * Canonical task id format: `YYYYMMDD-xxxxxxxx`
 *
 *   - YYYYMMDD: UTC-date prefix for at-a-glance grouping in `ls`
 *   - xxxxxxxx: 8 hex chars (4 random bytes), ~4B-id-per-day collision space
 *
 * Mirrors `@emploke/session`'s id format so operators see a consistent
 * pattern across both surfaces.
 */
export const TASK_ID_RE = /^\d{8}-[0-9a-f]{8}$/;

export function assertValidTaskId(id: string): void {
  if (typeof id !== "string" || !TASK_ID_RE.test(id)) {
    throw new InvalidTaskIdError(id);
  }
}

export function generateTaskId(
  now: () => Date = () => new Date(),
  randomBytes: (n: number) => Buffer = cryptoRandomBytes,
): string {
  const d = now();
  const date = pad4(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  const suffix = randomBytes(4).toString("hex");
  return `${date}-${suffix}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}

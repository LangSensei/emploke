import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { InvalidWorkflowIdError, InvalidWorkflowNodeIdError } from "./errors.js";

/**
 * Canonical id format for workflows and workflow nodes:
 * `YYYYMMDD-xxxxxxxx`.
 *
 *   - YYYYMMDD: UTC-date prefix for at-a-glance grouping in `ls`
 *   - xxxxxxxx: 8 hex chars (4 random bytes)
 *
 * Mirrors `@emploke/task` and `@emploke/session` id formats so
 * operators see one consistent pattern across every entity-pkg.
 */
export const WORKFLOW_ID_RE = /^\d{8}-[0-9a-f]{8}$/;
export const WORKFLOW_NODE_ID_RE = /^\d{8}-[0-9a-f]{8}$/;

export function assertValidWorkflowId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !WORKFLOW_ID_RE.test(id)) {
    throw new InvalidWorkflowIdError(String(id));
  }
}

export function assertValidWorkflowNodeId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !WORKFLOW_NODE_ID_RE.test(id)) {
    throw new InvalidWorkflowNodeIdError(String(id));
  }
}

export function generateWorkflowId(
  now: () => Date = () => new Date(),
  randomBytes: (n: number) => Buffer = cryptoRandomBytes,
): string {
  return generateDatedHexId(now, randomBytes);
}

export function generateWorkflowNodeId(
  now: () => Date = () => new Date(),
  randomBytes: (n: number) => Buffer = cryptoRandomBytes,
): string {
  return generateDatedHexId(now, randomBytes);
}

function generateDatedHexId(now: () => Date, randomBytes: (n: number) => Buffer): string {
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

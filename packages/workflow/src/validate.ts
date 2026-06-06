/**
 * Input validation for `@emploke/workflow`. Pure functions; no I/O.
 *
 * Scope is shape-only: id grammar (UUIDv4 for node ids; UUIDv4 OR the
 * legacy `<date>-<8hex>` shape for workflow ids) and enum-set
 * membership for the entity layer's round-trip checks.
 *
 * Cross-kind contracts (e.g. "a task's `agent` must appear in caller
 * coord's `dependencies.agents`") live in the kind handlers, not
 * here, because they need access to the catalog and the caller-coord
 * spec.
 *
 * Substrate invariants (e.g. "this node id already exists") live in
 * the engine, not here, because they need a DB read.
 *
 * Convention: validators THROW (`assertValidXxx`) so callers can use
 * TypeScript's `asserts ... is string` narrowing.
 */

import { randomUUID } from "node:crypto";
import {
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  WorkflowEnumValueError,
  WorkflowNodeKindShapeError,
} from "./errors.js";
import type { WorkflowNodeStatus, WorkflowStatus } from "./types.js";

// ─── Id grammars ────────────────────────────────────────────────────

// UUID v4. Same shape `crypto.randomUUID()` produces.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Legacy `<YYYYMMDD>-<8 hex>` shape carried over from `@emploke/task`
// for workflow ids only. Read-side accepts these so pre-existing
// workflows continue to round-trip; the substrate's id generator
// (`generateWorkflowId`) always emits UUIDv4 for new rows. Node ids
// never appear in `ls` output (they live inside their workflow dir,
// not at top-level), so the date-prefix's at-a-glance grouping
// benefit doesn't apply there — node ids are UUIDv4 only.
const LEGACY_DATED_HEX_RE = /^\d{8}-[0-9a-f]{8}$/;

/**
 * Workflow id grammar — UUIDv4 OR the legacy `<date>-<8 hex>` shape.
 * Both are accepted for read APIs so pre-existing workflows continue
 * to round-trip; new workflows MUST be created with UUIDv4 ids
 * (`generateWorkflowId` returns one).
 */
export function assertValidWorkflowId(id: unknown): asserts id is string {
  if (typeof id !== "string" || (!UUID_V4_RE.test(id) && !LEGACY_DATED_HEX_RE.test(id))) {
    throw new InvalidWorkflowIdError(String(id));
  }
}

/**
 * Workflow node id grammar — UUIDv4 only. No legacy shape support:
 * see the file-level note on why node ids don't need a date prefix.
 */
export function assertValidWorkflowNodeId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID_V4_RE.test(id)) {
    throw new InvalidWorkflowNodeIdError(String(id));
  }
}

/**
 * UUIDv4 generator with an injectable seam so tests can produce
 * deterministic ids by passing a stub.
 */
export function generateWorkflowId(randomUUIDFn: () => string = randomUUID): string {
  return randomUUIDFn();
}

/** UUIDv4 generator for new workflow nodes. */
export function generateWorkflowNodeId(randomUUIDFn: () => string = randomUUID): string {
  return randomUUIDFn();
}

// ─── Enum-set checks (used by entity round-trip; throw on miss) ─────

const VALID_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

const VALID_NODE_STATUSES: readonly WorkflowNodeStatus[] = [
  "not_started",
  "ready",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

/**
 * Enum-membership check for `workflow.status`. Throws
 * {@link WorkflowEnumValueError} on miss — used by
 * `WorkflowEntity.fromRow` to reject corrupted / hand-edited rows.
 */
export function assertValidWorkflowStatusEnum(status: unknown): asserts status is WorkflowStatus {
  if (
    typeof status !== "string" ||
    !(VALID_WORKFLOW_STATUSES as readonly string[]).includes(status)
  ) {
    throw new WorkflowEnumValueError("status", String(status), VALID_WORKFLOW_STATUSES);
  }
}

/**
 * Enum-membership check for `workflow_nodes.status`. Throws
 * {@link WorkflowEnumValueError} on miss — used by
 * `WorkflowNodeEntity.fromRow` to reject corrupted rows.
 */
export function assertValidWorkflowNodeStatusEnum(
  status: unknown,
): asserts status is WorkflowNodeStatus {
  if (typeof status !== "string" || !(VALID_NODE_STATUSES as readonly string[]).includes(status)) {
    throw new WorkflowEnumValueError("status", String(status), VALID_NODE_STATUSES);
  }
}

/**
 * Shape check for `workflow_nodes.kind`. The kind-set is open: the
 * substrate ships `'task'` + `'coordinator'` as baseline kinds, but
 * new kinds register at compose time against the service layer's
 * handler registry. This guard only enforces the shape contract
 * (non-empty string); "is this kind actually registered?" is the
 * service layer's job, since only the registry knows what's wired in.
 */
export function assertValidWorkflowNodeKind(kind: unknown): asserts kind is string {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new WorkflowNodeKindShapeError(String(kind));
  }
}

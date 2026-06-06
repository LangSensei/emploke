/**
 * Input validation for `@emploke/workflow` (v1.0.0). Pure functions;
 * no I/O.
 *
 * Phase 0 is **shape-only** validation: id grammar (UUIDv4 for node
 * ids; UUIDv4 OR the legacy `<date>-<8hex>` shape for workflow ids
 * to align with `@emploke/task`'s task-id pattern) and enum-set
 * membership for the entity layer's round-trip checks.
 *
 * Cross-kind contracts (e.g. "task agent must appear in caller
 * coord's `dependencies.agents`") live in the kind handlers
 * (Phase 4, `packages/api/src/wiring/`).
 *
 * Substrate invariants (e.g. "this node id already exists") live in
 * the engine (Phase 2+).
 *
 * Convention: validators THROW (`assertValidXxx`) so callers can use
 * TypeScript's `asserts ... is string` narrowing.
 */

import { randomUUID } from "node:crypto";
import {
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  WorkflowEnumValueError,
} from "./errors.js";
import type { WorkflowNodeStatus, WorkflowStatus } from "./types.js";

// ─── Id grammars ────────────────────────────────────────────────────

// UUID v4. Same shape `crypto.randomUUID()` produces.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Legacy `<YYYYMMDD>-<8 hex>` shape carried over from `@emploke/task`
// for workflow ids only. Per Q-schema-6 in SPEC.md, v1.0.0 generates
// workflow ids as UUIDv4 going forward, but legacy ids are still
// readable by the substrate. Node ids are UUIDv4 only (no display
// value in seeing when a node was created from the id alone).
const LEGACY_DATED_HEX_RE = /^\d{8}-[0-9a-f]{8}$/;

/**
 * Workflow id grammar — UUIDv4 (v1) OR the legacy `<date>-<8 hex>`
 * shape (carryover from v0.6.0 / `@emploke/task` task-id pattern).
 * Both are accepted for read APIs; new workflows MUST be created
 * with UUIDv4 ids per D31 (`generateWorkflowId` returns one).
 */
export function assertValidWorkflowId(id: unknown): asserts id is string {
  if (typeof id !== "string" || (!UUID_V4_RE.test(id) && !LEGACY_DATED_HEX_RE.test(id))) {
    throw new InvalidWorkflowIdError(String(id));
  }
}

/**
 * Workflow node id grammar — UUIDv4 only (D6 / Q-schema-6). No
 * legacy shape support: node ids never appear in `ls` output (nodes
 * live inside their workflow dir, not at top-level), so the date
 * prefix's "at-a-glance grouping" benefit doesn't apply.
 */
export function assertValidWorkflowNodeId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID_V4_RE.test(id)) {
    throw new InvalidWorkflowNodeIdError(String(id));
  }
}

/**
 * UUID v4 generator with an injectable seam (used by tests to
 * produce deterministic ids). Returns the workflow id format
 * actually used by v1.0.0 inserts (UUIDv4 per D31).
 */
export function generateWorkflowId(randomUUIDFn: () => string = randomUUID): string {
  return randomUUIDFn();
}

/** UUID v4 generator for new workflow nodes. */
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

// Kind-set is open (v1.0.0 ships `task` + `coordinator`; future kinds
// register at compose time). The validator below checks shape only
// — that the value is one of the v1 baseline kinds OR a non-empty
// string. The "registered with the service?" check belongs to the
// service layer (Phase 1+), which holds the live registry.
const V1_BASELINE_KINDS: readonly string[] = ["task", "coordinator"];

/**
 * Enum-membership check for `workflow.status`. Throws
 * {@link WorkflowEnumValueError} on miss — used by
 * `WorkflowEntity.fromRow` to reject corrupted / pre-migration data.
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
 * `WorkflowNodeEntity.fromRow` to reject corrupted data.
 */
export function assertValidWorkflowNodeStatusEnum(
  status: unknown,
): asserts status is WorkflowNodeStatus {
  if (typeof status !== "string" || !(VALID_NODE_STATUSES as readonly string[]).includes(status)) {
    throw new WorkflowEnumValueError("status", String(status), VALID_NODE_STATUSES);
  }
}

/**
 * Shape check for `workflow_nodes.kind`. Phase 0 accepts the two v1
 * baseline kinds (`task`, `coordinator`) AND any non-empty string
 * so future-kind rows round-trip; the service layer (Phase 1+)
 * enforces "kind must be registered" via its handler registry. The
 * baseline-membership predicate here exists for tests and dashboard
 * code that branch on the well-known set.
 */
export function assertValidWorkflowNodeKind(kind: unknown): asserts kind is string {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new WorkflowEnumValueError("kind", String(kind), V1_BASELINE_KINDS);
  }
}

// ─── Local error classes (id grammar) ───────────────────────────────
//
// Defined in `./errors.ts` alongside the other v1.0.0 error classes;
// imported above and re-thrown here. Keeps `errors.ts` as the single
// catalog of error classes the public barrel re-exports.

/**
 * Row ↔ entity mapping for `@emploke/workflow`.
 *
 * The entity layer is deliberately thin: it carries the persisted row
 * shape, parses `spec_json`, and validates enum membership at
 * round-trip time. Structural invariants ("FSM forward-only",
 * "coordinator_agent matches latest coord spec", "DAG acyclic",
 * "phase = MAX(parents.phase) + 1") are NOT enforced here — they
 * only make sense against the live SQL state (no orphan children, no
 * second coord successor, …) and so live on the service /
 * repository, not on a per-row entity.
 *
 * The entity layer's remaining job is:
 *
 *   1. `fromRow` — parse persisted JSON, validate enums (throws
 *      `WorkflowEnumValueCorruptionError` on miss). Defense-in-depth so a
 *      corrupted or hand-edited row can't smuggle a junk enum into
 *      the runtime.
 *   2. `toRow` — project the typed in-memory shape to a Drizzle
 *      insert payload (`spec_json` ← `JSON.stringify(spec)`).
 *
 * This package ships three entities: `WorkflowEntity` for the header
 * row, `WorkflowNodeEntity` for each node row, and a
 * `WorkflowEdgeEntity` value object (plain struct, no business
 * methods).
 */

import { WorkflowError } from "./errors.js";
import type {
  NewWorkflowEdgeRow,
  NewWorkflowNodeRow,
  NewWorkflowRow,
  WorkflowEdgeRow,
  WorkflowNodeRow,
  WorkflowRow,
} from "./schema.js";
import type {
  NodeKind,
  WorkflowCancellation,
  WorkflowFailure,
  WorkflowNodeSpecEnvelope,
  WorkflowNodeStatus,
  WorkflowStatus,
  WorkflowSuccess,
} from "./types.js";
import {
  assertValidWorkflowId,
  assertValidWorkflowNodeId,
  assertValidWorkflowNodeKind,
  assertValidWorkflowNodeStatusEnum,
  assertValidWorkflowStatusEnum,
  assertWorkflowCancellationShape,
  assertWorkflowFailureShape,
  assertWorkflowSuccessShape,
} from "./validate.js";

// ─── Workflow ───────────────────────────────────────────────────────

/**
 * Pure value-object representation of one workflow row.
 *
 * Construction is row-driven (`fromRow`) for reads and field-driven
 * (`create`) for writes. The service / repository hold the only
 * references; the public surface exposes the wire-shape projection
 * (`toDto`) when needed.
 *
 * The entity carries all persisted columns of the `workflows` table
 * plus `metadata` parsed from JSON (opaque `Record<string,
 * unknown>`). It does NOT carry the workflow's nodes / edges —
 * those are separate aggregates queried independently. There is no
 * `Workflow.addNode` here; structural mutation goes through the
 * service-layer primitives.
 */
export class WorkflowEntity {
  private constructor(
    readonly id: string,
    readonly brief: string,
    readonly details: string | undefined,
    readonly coordinatorAgent: string,
    readonly status: WorkflowStatus,
    readonly metadata: Readonly<Record<string, unknown>>,
    readonly createdAt: string,
    readonly startedAt: string | undefined,
    readonly endedAt: string | undefined,
    readonly success: WorkflowSuccess | undefined,
    readonly failure: WorkflowFailure | undefined,
    readonly cancellation: WorkflowCancellation | undefined,
  ) {}

  /**
   * Hydrate from a Drizzle row. Throws `WorkflowEnumValueCorruptionError`
   * if the persisted `status` is not in the known vocabulary.
   * `metadata` is JSON-parsed; corrupt JSON throws `WorkflowError`.
   *
   * Terminal-payload columns (`success` / `failure` / `cancellation`)
   * are JSON-parsed when non-null; each parsed payload is
   * shape-checked the same way `@emploke/task`'s `fromStored` checks
   * its payloads. A row with a non-null payload whose shape doesn't
   * match throws `WorkflowError`.
   *
   * **Tolerance branch for legacy rows**: a row with a terminal
   * `status` ('succeeded' / 'failed' / 'cancelled') but a NULL
   * matching-payload column does NOT throw. Pre-v2.2 rows (terminal,
   * payload columns NULL) are valid and the corresponding getter
   * returns `undefined`; the dashboard renders a "legacy-note" muted
   * message rather than failing the read. The cross-field invariant
   * "if a payload exists, its column must match the status" still
   * fires when a payload IS present.
   */
  static fromRow(row: WorkflowRow): WorkflowEntity {
    assertValidWorkflowId(row.id);
    assertValidWorkflowStatusEnum(row.status);
    const metadata = parseMetadataJson(row.id, row.metadata);
    const success = parseTerminalPayload<WorkflowSuccess>(
      row.id,
      "success",
      row.success,
      assertWorkflowSuccessShape,
    );
    const failure = parseTerminalPayload<WorkflowFailure>(
      row.id,
      "failure",
      row.failure,
      assertWorkflowFailureShape,
    );
    const cancellation = parseTerminalPayload<WorkflowCancellation>(
      row.id,
      "cancellation",
      row.cancellation,
      assertWorkflowCancellationShape,
    );
    // Cross-field invariant: a payload belongs to its own terminal
    // status (and only its own). A non-terminal row with any payload
    // attached is corrupt. Pre-v2.2 terminal rows with NULL payloads
    // are tolerated (see method JSDoc) — the matching-payload
    // requirement is conditional on the column being non-null.
    if (row.status === "succeeded" && (failure !== undefined || cancellation !== undefined)) {
      throw new WorkflowError(
        `Workflow "${row.id}" corrupted: status='succeeded' row carries failure/cancellation payload`,
      );
    }
    if (row.status === "failed" && (success !== undefined || cancellation !== undefined)) {
      throw new WorkflowError(
        `Workflow "${row.id}" corrupted: status='failed' row carries success/cancellation payload`,
      );
    }
    if (row.status === "cancelled" && (success !== undefined || failure !== undefined)) {
      throw new WorkflowError(
        `Workflow "${row.id}" corrupted: status='cancelled' row carries success/failure payload`,
      );
    }
    if (
      row.status === "running" &&
      (success !== undefined || failure !== undefined || cancellation !== undefined)
    ) {
      throw new WorkflowError(
        `Workflow "${row.id}" corrupted: status='running' row carries a terminal payload`,
      );
    }
    return new WorkflowEntity(
      row.id,
      row.brief,
      row.details ?? undefined,
      row.coordinatorAgent,
      row.status,
      metadata,
      row.createdAt,
      row.startedAt ?? undefined,
      row.endedAt ?? undefined,
      success,
      failure,
      cancellation,
    );
  }

  /** Project to a Drizzle insert payload. */
  toRow(): NewWorkflowRow {
    return {
      id: this.id,
      brief: this.brief,
      details: this.details ?? null,
      coordinatorAgent: this.coordinatorAgent,
      status: this.status,
      metadata: JSON.stringify(this.metadata),
      createdAt: this.createdAt,
      startedAt: this.startedAt ?? null,
      endedAt: this.endedAt ?? null,
      success: this.success === undefined ? null : JSON.stringify(this.success),
      failure: this.failure === undefined ? null : JSON.stringify(this.failure),
      cancellation: this.cancellation === undefined ? null : JSON.stringify(this.cancellation),
    };
  }
}

// ─── WorkflowNode ───────────────────────────────────────────────────

/**
 * Pure value-object representation of one `workflow_nodes` row.
 *
 * The substrate stores `spec` opaquely (`unknown`). The per-kind
 * `WorkflowNodeRunner` for `this.kind` is the only piece of code
 * that knows the typed shape; the entity itself never branches on
 * `kind`.
 */
export class WorkflowNodeEntity {
  private constructor(
    readonly id: string,
    readonly workflowId: string,
    readonly kind: NodeKind,
    readonly spec: unknown,
    readonly phase: number,
    readonly status: WorkflowNodeStatus,
    readonly createdAt: string,
    readonly readyAt: string | undefined,
    readonly runningAt: string | undefined,
    readonly endedAt: string | undefined,
  ) {}

  /**
   * Hydrate from a Drizzle row. Throws:
   *
   *   - `InvalidWorkflowIdError` / `InvalidWorkflowNodeIdError` if
   *     ids fail grammar.
   *   - `WorkflowEnumValueCorruptionError` if `status` is not in the
   *     known node-status vocabulary.
   *   - `WorkflowNodeKindShapeError` if `kind` is not a known
   *     `NodeKind` (defensive guard against schema corruption).
   *   - `WorkflowError` if `spec_json` is not valid JSON.
   */
  static fromRow(row: WorkflowNodeRow): WorkflowNodeEntity {
    assertValidWorkflowNodeId(row.id);
    assertValidWorkflowId(row.workflowId);
    assertValidWorkflowNodeKind(row.kind);
    assertValidWorkflowNodeStatusEnum(row.status);
    const spec = parseSpecJson(row.id, row.specJson);
    return new WorkflowNodeEntity(
      row.id,
      row.workflowId,
      row.kind,
      spec,
      row.phase,
      row.status,
      row.createdAt,
      row.readyAt ?? undefined,
      row.runningAt ?? undefined,
      row.endedAt ?? undefined,
    );
  }

  /** The opaque envelope projection — `{ kind, spec }`. */
  toEnvelope(): WorkflowNodeSpecEnvelope {
    return { kind: this.kind, spec: this.spec };
  }

  /** Project to a Drizzle insert payload. */
  toRow(): NewWorkflowNodeRow {
    return {
      id: this.id,
      workflowId: this.workflowId,
      kind: this.kind,
      specJson: JSON.stringify(this.spec),
      phase: this.phase,
      status: this.status,
      createdAt: this.createdAt,
      readyAt: this.readyAt ?? null,
      runningAt: this.runningAt ?? null,
      endedAt: this.endedAt ?? null,
    };
  }
}

// ─── WorkflowEdge ───────────────────────────────────────────────────

/**
 * Plain value object for one DAG edge. No mutation methods — edges
 * are added / removed via the substrate's `addEdge` / `removeEdge`
 * primitives, not via the entity layer.
 */
export class WorkflowEdgeEntity {
  private constructor(
    readonly workflowId: string,
    readonly from: string,
    readonly to: string,
  ) {}

  static fromRow(row: WorkflowEdgeRow): WorkflowEdgeEntity {
    assertValidWorkflowId(row.workflowId);
    assertValidWorkflowNodeId(row.fromNodeId);
    assertValidWorkflowNodeId(row.toNodeId);
    return new WorkflowEdgeEntity(row.workflowId, row.fromNodeId, row.toNodeId);
  }

  toRow(): NewWorkflowEdgeRow {
    return {
      workflowId: this.workflowId,
      fromNodeId: this.from,
      toNodeId: this.to,
    };
  }
}

// ─── JSON parse helpers ─────────────────────────────────────────────

function parseMetadataJson(rowId: string, raw: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkflowError(
      `Workflow "${rowId}" corrupted: metadata is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError(
      `Workflow "${rowId}" corrupted: metadata must be a JSON object, got ${typeof parsed}`,
    );
  }
  return Object.freeze({ ...(parsed as Record<string, unknown>) });
}

function parseSpecJson(nodeId: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new WorkflowError(
      `Workflow node "${nodeId}" corrupted: spec_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Parse one of the optional terminal-payload columns. Returns
 * `undefined` when the column is null/undefined (the tolerance branch
 * for pre-existing rows). When the column is a string, parses it as
 * JSON, coerces legacy discriminator values onto the current
 * single-arm vocabulary, and runs the supplied shape validator; a
 * parse error or shape mismatch surfaces as `WorkflowError`.
 *
 * Legacy coercions (tolerance read path):
 *   - `failure.kind` ∈ {`coord`, `internal`} → `coordinator`
 *   - `cancellation.kind` === `cascade` → `user`
 *
 * The corresponding write path is migration-aware: see
 * `packages/workflow/drizzle/0003_v2_5_cleanup.sql`.
 */
function parseTerminalPayload<T>(
  rowId: string,
  field: "success" | "failure" | "cancellation",
  raw: string | null,
  assertShape: (id: string, value: T) => void,
): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorkflowError(
      `Workflow "${rowId}" corrupted: ${field} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (field === "failure" && parsed !== null && typeof parsed === "object") {
    const v = parsed as { kind?: unknown };
    if (v.kind === "coord" || v.kind === "internal") {
      (parsed as { kind: string }).kind = "coordinator";
    }
  } else if (field === "cancellation" && parsed !== null && typeof parsed === "object") {
    const v = parsed as { kind?: unknown };
    if (v.kind === "cascade") {
      (parsed as { kind: string }).kind = "user";
    }
  }
  assertShape(rowId, parsed as T);
  return parsed as T;
}

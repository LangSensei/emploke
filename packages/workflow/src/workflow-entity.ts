/**
 * Row ↔ entity mapping for `@emploke/workflow` (v1.0.0).
 *
 * Phase 0 keeps the entity layer **minimal**: it carries the persisted
 * row shape, parses `spec_json`, and validates enum membership at
 * round-trip time. **Substrate-level invariants** ("FSM forward-only",
 * "coordinator_agent matches latest coord spec", "DAG acyclic", "phase
 * = MAX(parents.phase) + 1") live in the engine (Phase 2+), NOT here.
 *
 * The v0.6.0 file carried heavy entity-level invariants because v0.6.0
 * was append-only-everywhere and a `Workflow` aggregate could
 * meaningfully validate itself in isolation. v1.0.0 has mutation
 * primitives (addEdge, removeNode, …) whose invariants only make
 * sense against the live SQL state (no orphan children, no second
 * coord successor, …) — those belong on the service / repository,
 * not on a per-row entity.
 *
 * The entity layer's remaining job is:
 *
 *   1. `fromRow` — parse persisted JSON, validate enums (throws
 *      `WorkflowEnumValueError` on miss). Defense-in-depth so a
 *      pre-migration row or hand-edited DB can't smuggle a corrupted
 *      enum into the runtime.
 *   2. `toRow` — project the typed in-memory shape to a Drizzle
 *      insert payload (`spec_json` ← `JSON.stringify(spec)`).
 *
 * Mirrors `@emploke/schedule`'s `ScheduleEntity` byte-for-byte in
 * role; the differences are: this pkg has TWO entities
 * (`WorkflowEntity` for the header row, `WorkflowNodeEntity` for
 * each node row) and an `WorkflowEdgeEntity` value object (plain
 * struct, no business methods).
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
import type { WorkflowNodeSpecEnvelope, WorkflowNodeStatus, WorkflowStatus } from "./types.js";
import {
  assertValidWorkflowId,
  assertValidWorkflowNodeId,
  assertValidWorkflowNodeKind,
  assertValidWorkflowNodeStatusEnum,
  assertValidWorkflowStatusEnum,
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
 * The entity carries:
 *   - all persisted columns of the v1.0.0 `workflows` table.
 *   - `metadata` parsed from JSON (opaque `Record<string, unknown>`).
 *
 * It does NOT carry:
 *   - the workflow's nodes / edges (those are separate aggregates
 *     queried independently; the v0.6.0 single-aggregate model is
 *     gone — there's no `Workflow.addNode` here).
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
  ) {}

  /**
   * Hydrate from a Drizzle row. Throws `WorkflowEnumValueError` if
   * the persisted `status` is not in the v1 vocabulary.
   * `metadata` is JSON-parsed; corrupt JSON throws `WorkflowError`.
   */
  static fromRow(row: WorkflowRow): WorkflowEntity {
    assertValidWorkflowId(row.id);
    assertValidWorkflowStatusEnum(row.status);
    const metadata = parseMetadataJson(row.id, row.metadata);
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
    };
  }
}

// ─── WorkflowNode ───────────────────────────────────────────────────

/**
 * Pure value-object representation of one `workflow_nodes` row.
 *
 * The substrate stores `spec` opaquely (`unknown`). The registered
 * `WorkflowNodeKindHandler` for `this.kind` is the only piece of code
 * that knows the typed shape; the entity itself never branches on
 * `kind`.
 */
export class WorkflowNodeEntity {
  private constructor(
    readonly id: string,
    readonly workflowId: string,
    readonly kind: string,
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
   *   - `WorkflowEnumValueError` if `status` is not in the v1 node-
   *     status vocabulary or if `kind` is empty.
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
 * primitives (Phase 1+), not via the entity layer.
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

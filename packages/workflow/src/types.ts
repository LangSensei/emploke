/**
 * Public types for `@emploke/workflow` (v1.0.0).
 *
 * The workflow pkg is an open substrate: it stores `workflow_nodes`
 * rows with an opaque `{ kind: string, spec: unknown }` envelope and
 * routes every kind-aware operation (validate, dispatch, in-flight
 * check, cancel) through a {@link WorkflowNodeKindHandler} the caller
 * registers at compose time. The pkg has no built-in knowledge of
 * `'task'`, `'coordinator'`, or any other concrete kind — adding one
 * requires zero edits to `packages/workflow/src/`.
 *
 * Per-kind wire DTOs (`WorkflowTaskNodeSpec`,
 * `WorkflowCoordinatorNodeSpec`, `WorkflowNodeWireSpec`, …) live in
 * `@emploke/contracts/workflows` and are re-exported below so
 * external callers don't need to know which package owns the wire
 * shapes (mirrors how `@emploke/schedule` does for schedule wire
 * targets).
 *
 * See `packages/workflow/SPEC.md` §"TS-layer types" for the
 * authoritative definitions and §"Locked design decisions" for the
 * rationale behind the FSM enums.
 */

// ─── Re-exports from @emploke/contracts ─────────────────────────────
//
// Workflow node spec wire types live in `@emploke/contracts` because
// they cross the HTTP wire and are consumed by the SPA / CLI. The
// workflow substrate re-exports them so consumers can `import { ... }
// from "@emploke/workflow"` without learning that DTOs come from a
// sibling package. Mirrors `@emploke/schedule`'s pattern of
// re-exporting `TaskScheduleTargetWire` etc.
export type {
  WorkflowCoordinatorNodeSpec,
  WorkflowCoordinatorNodeSpecWire,
  WorkflowNodeWireSpec,
  WorkflowTaskNodeSpec,
  WorkflowTaskNodeSpecWire,
} from "@emploke/contracts";

// ─── FSM enums ──────────────────────────────────────────────────────

/**
 * Workflow-level FSM. **Four values, exactly one non-terminal** (D1,
 * D26). The substrate never writes `'coordinating'`; whether the
 * workflow is "actively coordinating right now" is derived from
 * `workflow_nodes` (`EXISTS WHERE kind='coordinator' AND status =
 * 'running'`) — see {@link hasLiveCoord}.
 *
 * Forward-only: once a workflow hits a terminal status, no further
 * status mutation is allowed (engine invariant; Phase 2+).
 */
export type WorkflowStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * Per-node FSM (unchanged from v0.6.0; applies to BOTH task-kind and
 * coordinator-kind nodes per D2).
 *
 *   not_started ─ready─► ready ─launch─► running ─done────► succeeded
 *                                                └─fail────► failed
 *
 * `cancelled` is the cancel terminal (legal from `not_started`,
 * `ready`, or `running` for task-kind only — per Q-schema-9). Coord-
 * kind cancellation goes through `cancelWorkflow`, not `cancelNode`.
 */
export type WorkflowNodeStatus =
  | "not_started"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

// ─── Derived-view helpers (NOT persisted) ───────────────────────────

/**
 * "Is there a coord actively running right now?" — derived from node
 * state, not from a workflow column (D15). Clients call this OR run
 * the equivalent SQL directly; this helper is the sugar.
 *
 * Pure function; safe to call from anywhere (SPA, CLI, server).
 */
export function hasLiveCoord(
  nodes: ReadonlyArray<{
    readonly kind: string;
    readonly status: WorkflowNodeStatus;
  }>,
): boolean {
  return nodes.some((n) => n.kind === "coordinator" && n.status === "running");
}

/**
 * Iteration count — the number of coordinator-kind nodes ever
 * created in this workflow. UI / CLI use it to render "Iteration N"
 * labels. Silent-retry coord nodes (D20) ARE counted; per SPEC.md
 * §UI rendering, "a retry IS an iteration from the user's
 * perspective".
 *
 * Pure function over a pre-computed count; the workflow pkg's
 * service layer (Phase 1+) provides a one-shot SQL to get the
 * count.
 */
export function deriveIterationCount(coordNodeCount: number): number {
  return coordNodeCount;
}

// ─── Kind-handler substrate interface ───────────────────────────────

/**
 * Opaque envelope persisted by the workflow pkg for every node. The
 * `spec` payload is `unknown` because the substrate deliberately
 * doesn't know per-kind shape; the registered
 * {@link WorkflowNodeKindHandler} owns parsing / validation /
 * dispatch / in-flight check / cancel.
 *
 * On disk: `kind` lives in `workflow_nodes.kind` and `spec` is
 * `JSON.stringify`ed into `workflow_nodes.spec_json`. The kind is
 * NOT redundantly nested inside `spec_json` (mirrors
 * `ScheduleEntity.toRow`).
 */
export interface WorkflowNodeSpecEnvelope {
  readonly kind: string;
  readonly spec: unknown;
}

/**
 * Context threaded into `WorkflowNodeKindHandler.validate`. Carries
 * caller-coord identity so per-kind validators can enforce
 * cross-coord rules (e.g. invariant #9: a task-kind node's `agent`
 * must appear in the caller coord's `dependencies.agents`).
 *
 * For `createWorkflow`'s initial coord insert AND for the silent-
 * retry coord insert (D20), the substrate populates the ctx fields
 * with the just-inserted coord's identity (callerCoordNodeId =
 * self id; callerCoordSpec = self spec). See SPEC.md §"createWorkflow"
 * and §"silent retry" for the exact bootstrap rule.
 */
export interface WorkflowNodeValidateCtx {
  readonly workflowId: string;
  /**
   * The coord node calling the mutation primitive — i.e. the parent
   * in the auth/causality sense. For the initial coord insert and
   * the silent-retry insert, this is the just-inserted node's own
   * id (self).
   */
  readonly callerCoordNodeId: string;
  /**
   * The caller coord's persisted spec. The task-kind handler reads
   * `callerCoordSpec.agent` to enforce that the worker's FQN appears
   * in the coord agent's `dependencies.agents`.
   */
  readonly callerCoordSpec: { readonly agent: string };
  /**
   * Useful for cross-workflow-state checks; rarely needed. Always
   * `'running'` when called from a mutation primitive (the D22 auth
   * gate rejects mutations on terminal workflows).
   */
  readonly workflowStatus: WorkflowStatus;
}

/**
 * Per-kind handler registered at compose time via
 * `WorkflowService.registerKind(kind, handler)` (Phase 1+).
 * Implementations live wherever the kind is integrated — both v1
 * handlers live in `packages/api/src/wiring/` (Phase 4) because they
 * know about `@emploke/workflow`, `@emploke/task`, AND
 * `@emploke/catalog`. The substrate pkg itself never imports any of
 * its callers.
 *
 * No capabilities flag (D18). The substrate's coord-special
 * behaviors are encoded in the engine itself (the auth gate, the
 * silent-retry trigger, the `workflows.coordinator_agent` denorm
 * sync) — NOT routed through a polymorphic interface method. The
 * handler interface is intentionally minimal: validate / dispatch /
 * hasInFlightForNode / cancel.
 *
 * Mirrors `@emploke/schedule`'s `ScheduleKindHandler` byte-for-byte
 * in role.
 */
export interface WorkflowNodeKindHandler {
  /**
   * Validate an inbound `spec` payload. MUST throw on invalid shape;
   * MAY perform async side-effects (e.g. catalog existence lookup
   * for an agent FQN). Returns the validated / normalized payload,
   * which the substrate persists as `spec_json`. Implementations are
   * free to normalize (trim, drop unknown keys); the returned value
   * is what gets stored.
   */
  validate(spec: unknown, ctx: WorkflowNodeValidateCtx): Promise<unknown>;

  /**
   * Fire the unit of work backing this node. Called by the substrate
   * when the node transitions `not_started|ready → running` (via
   * `dispatchAtomic`; see invariant #12 in SPEC.md). The handler
   * dispatches whatever it needs (e.g. a task) and stamps
   * `{ workflowId, workflowNodeId }` into the unit's metadata so the
   * reverse-lookup partial indexes engage.
   *
   * Returns a substrate-side identifier (e.g. task id) for audit;
   * the substrate does NOT persist this id — reverse lookup goes
   * through the unit's metadata, not through a `workflow_nodes`
   * column.
   */
  dispatch(opts: {
    readonly workflowId: string;
    readonly nodeId: string;
    readonly spec: unknown;
    readonly nodeDir: string;
  }): Promise<{ readonly unitId: string }>;

  /**
   * Whether this kind currently has a dispatched-but-incomplete
   * unit-of-work for `nodeId`. Used by cancel reconciliation AND by
   * engine-restart recovery (running rows with no in-flight unit get
   * rolled back to ready).
   */
  hasInFlightForNode(nodeId: string): Promise<boolean>;

  /**
   * Cancel the in-flight unit-of-work for `nodeId`. Idempotent;
   * best-effort. See SPEC.md §"cancelNode" for the substrate's
   * cancel semantics (cancellation is "the substrate will ignore
   * the unit-of-work", NOT proof that the unit has actually
   * stopped).
   */
  cancel(nodeId: string): Promise<void>;
}

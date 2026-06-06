/**
 * Error hierarchy for `@emploke/workflow` (v1.0.0).
 *
 * All errors extend {@link WorkflowError} so callers can `instanceof`
 * a coarse check within the same realm; cross-realm callers (HTTP
 * routes, CLI) should branch on the stable `name` string literal
 * (set per-class so `instanceof` survives module-boundary identity
 * loss).
 *
 * Each error MUST be a discrete subclass so the upstream error-
 * policy table (server route layer) can map each to its appropriate
 * HTTP status without sniffing message text. Phase 0 declares the
 * full v1.0.0 error set; only a subset is thrown in Phase 0 (entity
 * round-trip + validate), the rest land progressively in Phase 1+
 * as the mutation primitives ship.
 *
 * See `packages/workflow/SPEC.md` §"Per-primitive rejection rule
 * summary" and the D-decisions for which primitive throws what.
 */

export class WorkflowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "WorkflowError";
  }
}

// ─── 404 / not-found ────────────────────────────────────────────────

export class WorkflowNotFoundError extends WorkflowError {
  override readonly name = "WorkflowNotFoundError";
  constructor(public readonly workflowId: string) {
    super(`Workflow "${workflowId}" not found`);
  }
}

export class WorkflowNodeNotFoundError extends WorkflowError {
  override readonly name = "WorkflowNodeNotFoundError";
  constructor(
    public readonly workflowId: string,
    public readonly nodeId: string,
  ) {
    super(`Workflow node "${nodeId}" not found in workflow "${workflowId}"`);
  }
}

export class WorkflowEdgeNotFoundError extends WorkflowError {
  override readonly name = "WorkflowEdgeNotFoundError";
  constructor(
    public readonly workflowId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Workflow edge ${from}→${to} not found in workflow "${workflowId}"`);
  }
}

// ─── Id-grammar guards (thrown by validate.ts) ──────────────────────

export class InvalidWorkflowIdError extends WorkflowError {
  override readonly name = "InvalidWorkflowIdError";
  constructor(public readonly id: string) {
    super(`Invalid workflow id: "${id}"`);
  }
}

export class InvalidWorkflowNodeIdError extends WorkflowError {
  override readonly name = "InvalidWorkflowNodeIdError";
  constructor(public readonly id: string) {
    super(`Invalid workflow node id: "${id}"`);
  }
}

// ─── Lifecycle / FSM ────────────────────────────────────────────────

/**
 * Thrown by `finishWorkflow` / `cancelWorkflow` when the CAS update
 * affects 0 rows — the workflow was already terminal. Maps to a 409
 * at the HTTP layer.
 */
export class WorkflowAlreadyTerminalError extends WorkflowError {
  override readonly name = "WorkflowAlreadyTerminalError";
  constructor(public readonly workflowId: string) {
    super(`Workflow "${workflowId}" is already terminal`);
  }
}

/**
 * Thrown when a mutation primitive is called by a caller that does
 * NOT satisfy the D22 cross-cut auth predicate: caller node must be
 * `kind='coordinator' AND status='running'` and the workflow must be
 * `status='running'`. The single auth gate shared by all 8 mutation
 * primitives (D22).
 */
export class WorkflowMutationUnauthorizedError extends WorkflowError {
  override readonly name = "WorkflowMutationUnauthorizedError";
  constructor(
    public readonly workflowId: string,
    public readonly callerNodeId: string,
    public readonly reason: string,
  ) {
    super(`Workflow "${workflowId}" mutation by node "${callerNodeId}" denied: ${reason}`);
  }
}

/**
 * Thrown when a mutation targets a node whose status disallows the
 * change. Per D24 ("structural sealing"): `replaceNodeSpec` /
 * `removeNode` reject anything not `not_started`; `addEdge` /
 * `removeEdge` reject if the to-node isn't `not_started`;
 * `cancelNode` is the only mutation legal on `running` (task-kind
 * only). Maps to 409.
 */
export class WorkflowNodeNotMutableError extends WorkflowError {
  override readonly name = "WorkflowNodeNotMutableError";
  constructor(
    public readonly workflowId: string,
    public readonly nodeId: string,
    public readonly status: string,
    public readonly verb: string,
  ) {
    super(
      `Workflow node "${nodeId}" (status="${status}") in workflow "${workflowId}" is not mutable via "${verb}"`,
    );
  }
}

// ─── DAG / edge structure ───────────────────────────────────────────

/**
 * Thrown when `addEdge` / `addNode` / `addSubgraph` would close a
 * cycle on the DAG. Renamed from v0.6.0's `WorkflowCycleError` for
 * symmetry with `WorkflowEdgeNotFoundError` /
 * `WorkflowEdgeAlreadyExistsError`.
 */
export class WorkflowEdgeCycleError extends WorkflowError {
  override readonly name = "WorkflowEdgeCycleError";
  constructor(
    public readonly workflowId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Adding edge ${from}→${to} would create a cycle in workflow "${workflowId}"`);
  }
}

export class WorkflowEdgeAlreadyExistsError extends WorkflowError {
  override readonly name = "WorkflowEdgeAlreadyExistsError";
  constructor(
    public readonly workflowId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Edge ${from}→${to} already exists in workflow "${workflowId}"`);
  }
}

/**
 * Thrown by `removeNode` / `removeEdge` when the removal would leave
 * a downstream child with zero parents. The coord must remove the
 * child first (cascading bottom-up) OR add a replacement parent edge
 * before removing.
 */
export class WouldOrphanChildError extends WorkflowError {
  override readonly name = "WouldOrphanChildError";
  constructor(
    public readonly workflowId: string,
    public readonly nodeId: string,
    public readonly orphanedChildId: string,
  ) {
    super(`Removing ${nodeId} would orphan child "${orphanedChildId}" in workflow "${workflowId}"`);
  }
}

// ─── Per-kind insert structural rules ───────────────────────────────

/**
 * Thrown when `addNode(kind, …)` or `addSubgraph` references a
 * `kind` that has no registered handler (invariant #10). Operator-
 * config bug; the server's error-policy table maps to 500.
 */
export class WorkflowNodeKindUnknownError extends WorkflowError {
  override readonly name = "WorkflowNodeKindUnknownError";
  constructor(public readonly kind: string) {
    super(
      `Workflow node kind "${kind}" is not registered. Call workflowService.registerKind("${kind}", handler) at compose time.`,
    );
  }
}

/**
 * Generic spec validation error thrown by `WorkflowNodeKindHandler.
 * validate` implementations and re-thrown by the substrate's
 * mutation primitives. Per-kind handlers SHOULD throw a subclass
 * (e.g. `WorkflowTaskNodeSpecError`) for finer error mapping; this
 * base class catches the generic case and provides a coherent name
 * for the error-policy table to map to 400.
 */
export class WorkflowNodeSpecError extends WorkflowError {
  override readonly name = "WorkflowNodeSpecError";
  constructor(
    public readonly kind: string,
    detail: string,
  ) {
    super(`Invalid workflow node spec for kind "${kind}": ${detail}`);
  }
}

/**
 * D23 violation. Thrown by `addNode(kind='coordinator')` /
 * `addSubgraph` when the caller coord already has ≥1 coord-kind
 * child node. Combined with D27 (caller must be parent of inserted
 * coord) this structurally guarantees the "non-terminal coord chain
 * has length 1 or 2" invariant.
 */
export class MultipleSuccessorCoordsError extends WorkflowError {
  override readonly name = "MultipleSuccessorCoordsError";
  constructor(
    public readonly workflowId: string,
    public readonly callerCoordNodeId: string,
  ) {
    super(
      `Coordinator node "${callerCoordNodeId}" in workflow "${workflowId}" already has a coord-kind child; cannot add a second (D23)`,
    );
  }
}

/**
 * D27 violation. Thrown by `addNode(kind='coordinator')` /
 * `addSubgraph` when the inserted coord-kind node does NOT have the
 * caller coord's id in its parent set. Closes the loophole where
 * D23 could be bypassed by adding coord children to other nodes.
 */
export class OrphanCoordInsertError extends WorkflowError {
  override readonly name = "OrphanCoordInsertError";
  constructor(
    public readonly workflowId: string,
    public readonly callerCoordNodeId: string,
  ) {
    super(
      `Inserted coord node must have caller coord "${callerCoordNodeId}" in its parent set in workflow "${workflowId}" (D27)`,
    );
  }
}

/**
 * D29 violation. Thrown when a `kind='task'` node insert references
 * a parent in `{failed, cancelled}` — the task would be permanently
 * un-dispatchable (invariant #12 requires all parents `succeeded`
 * for task-kind). Coord-kind nodes accept any terminal parent
 * (they're supposed to wake on failure), so this error only fires
 * for task-kind.
 */
export class ParentStateError extends WorkflowError {
  override readonly name = "ParentStateError";
  constructor(
    public readonly workflowId: string,
    public readonly nodeKind: string,
    public readonly parentNodeId: string,
    public readonly parentStatus: string,
  ) {
    super(
      `Cannot add ${nodeKind}-kind node with parent "${parentNodeId}" (status="${parentStatus}") in workflow "${workflowId}" (D29)`,
    );
  }
}

/**
 * `addSubgraph` rejection: a temp node has no parents (neither
 * `existingParents` entries nor incoming intra-batch edges). Every
 * temp must root somewhere in the existing DAG.
 */
export class ParentlessTempError extends WorkflowError {
  override readonly name = "ParentlessTempError";
  constructor(
    public readonly workflowId: string,
    public readonly tempId: string,
  ) {
    super(`addSubgraph: temp node "${tempId}" has no parents (workflow "${workflowId}")`);
  }
}

/**
 * `addSubgraph` rejection: an edge references a `tempId` not
 * declared in `batch.nodes`.
 */
export class UnknownTempIdError extends WorkflowError {
  override readonly name = "UnknownTempIdError";
  constructor(
    public readonly workflowId: string,
    public readonly tempId: string,
  ) {
    super(`addSubgraph: edge references unknown tempId "${tempId}" (workflow "${workflowId}")`);
  }
}

// ─── Entity round-trip integrity ────────────────────────────────────

/**
 * Thrown by entity `fromRow` factories when a persisted enum value
 * is not in the v1 vocabulary (e.g. a leftover `'archived'` workflow
 * status from a v0.6.0 DB). Operator-config / migration bug; maps
 * to 500 with an opaque body.
 */
export class WorkflowEnumValueError extends WorkflowError {
  override readonly name = "WorkflowEnumValueError";
  constructor(
    public readonly field: string,
    public readonly value: string,
    public readonly allowed: readonly string[],
  ) {
    super(`Invalid value "${value}" for "${field}"; allowed: ${allowed.join(", ")}`);
  }
}

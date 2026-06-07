/**
 * Error hierarchy for `@emploke/workflow`.
 *
 * All errors extend {@link WorkflowError} so callers can `instanceof`
 * a coarse check within the same realm; cross-realm callers (HTTP
 * routes, CLI) should branch on the stable `name` string literal
 * (set per-class so `instanceof` survives module-boundary identity
 * loss).
 *
 * Each error is a discrete subclass so the upstream error-policy
 * table (server route layer) can map each to its appropriate HTTP
 * status without sniffing message text.
 */

export class WorkflowError extends Error {
  override readonly name: string = "WorkflowError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
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
 * NOT satisfy the cross-cut auth predicate: the caller node must be
 * `kind='coordinator' AND status='running'`, AND the workflow itself
 * must be `status='running'`. The single auth gate shared by every
 * mutation primitive on the substrate.
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
 * change. The "structural sealing" rule: `replaceNodeSpec` /
 * `removeNode` reject anything not `not_started`; `addEdge` /
 * `removeEdge` reject if the to-node isn't `not_started`;
 * `cancelNode` is the only mutation legal on `running` (and only
 * for worker-kind nodes). Maps to 409.
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
 * cycle on the DAG.
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

// ─── Per-kind insert structural rules ───────────────────────────────

/**
 * Defensive runtime guard against schema corruption — thrown when a
 * persisted `workflow_nodes.kind` value falls outside the substrate's
 * closed kind enum (`'coordinator' | 'worker'`). Cannot fire from
 * caller-supplied input: the mutation primitives type `kind` as
 * `NodeKind`, so TypeScript rejects unknown literals at compile time.
 *
 * Real-world trigger paths: a hand-edited DB row, or a row written by
 * an older binary that supported a kind value since removed from the
 * enum. Operator/data-corruption class; the server's error-policy
 * table maps to 500.
 */
export class WorkflowNodeKindUnknownError extends WorkflowError {
  override readonly name = "WorkflowNodeKindUnknownError";
  constructor(public readonly kind: string) {
    super(
      `Workflow node kind "${kind}" is not a known kind (expected one of: "coordinator", "worker"). This indicates schema corruption or a row written by an older binary.`,
    );
  }
}

/**
 * Generic spec validation error thrown by `WorkflowNodeRunner.
 * validate` implementations and re-thrown by the substrate's
 * mutation primitives. Per-kind runners SHOULD throw a subclass
 * (e.g. `WorkflowWorkerNodeSpecError`) for finer error mapping; this
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
 * Thrown by `addNode(kind='coordinator')` / `addSubgraph` when the
 * caller coord already has ≥1 coordinator-kind child node.
 *
 * Combined with the "inserted coord must list the caller as a parent"
 * rule (see {@link OrphanCoordInsertError}), this structurally
 * guarantees the substrate's "non-terminal coord chain has length 1
 * or 2" invariant: at any moment, the live coords form a chain of
 * length 1 (the currently-running coord) or 2 (the running coord
 * plus a single pending successor it has just enqueued).
 */
export class MultipleSuccessorCoordsError extends WorkflowError {
  override readonly name = "MultipleSuccessorCoordsError";
  constructor(
    public readonly workflowId: string,
    public readonly callerCoordNodeId: string,
  ) {
    super(
      `Coordinator node "${callerCoordNodeId}" in workflow "${workflowId}" already has a coord-kind child; cannot add a second`,
    );
  }
}

/**
 * Thrown by `addNode(kind='coordinator')` / `addSubgraph` when the
 * inserted coordinator-kind node does NOT have the caller coord's id
 * in its parent set.
 *
 * Required for the coord-chain invariant: without this rule the
 * "≤1 coord successor per coord" check could be bypassed by adding
 * coord children to non-coord nodes. With this rule, every new coord
 * is structurally chained off its predecessor.
 */
export class OrphanCoordInsertError extends WorkflowError {
  override readonly name = "OrphanCoordInsertError";
  constructor(
    public readonly workflowId: string,
    public readonly callerCoordNodeId: string,
  ) {
    super(
      `Inserted coord node must have caller coord "${callerCoordNodeId}" in its parent set in workflow "${workflowId}"`,
    );
  }
}

/**
 * Thrown when a `kind='worker'` node insert references a parent in
 * `{failed, cancelled}` — the worker would be permanently
 * un-dispatchable because the worker-kind dispatch-readiness rule
 * requires every parent to be `succeeded`. Coordinator-kind nodes
 * accept any terminal parent (they're specifically supposed to wake
 * to handle failure), so this error fires only for worker-kind
 * inserts.
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
      `Cannot add ${nodeKind}-kind node with parent "${parentNodeId}" (status="${parentStatus}") in workflow "${workflowId}"`,
    );
  }
}

/**
 * Thrown by `addNode` when `parents.length === 0`. The substrate
 * mandates `parents.length ≥ 1` on every primitive insert: the
 * initial coord (created via `createWorkflow`) is the unique
 * phase-0 entry point, and every subsequent node roots in the
 * existing DAG. Structural rejection — fires before the auth gate
 * so the precondition is order-independent of caller state.
 */
export class EmptyParentsError extends WorkflowError {
  override readonly name = "EmptyParentsError";
  constructor() {
    super("node parents must contain at least one parent node");
  }
}

// ─── Entity round-trip integrity ────────────────────────────────────

/**
 * Thrown by entity `fromRow` factories when a persisted enum value
 * is not in the current vocabulary (e.g. a hand-edited DB or a
 * pre-migration row that smuggled in an unknown status). Operator/
 * data-corruption error; maps to 500 with an opaque body.
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

/**
 * Thrown by `assertValidWorkflowNodeKind` when the value is not a
 * non-empty string. Distinct from {@link WorkflowEnumValueError}:
 * the entity-layer kind guard checks shape only (`assertValidXxx`
 * pattern); membership against the closed `NodeKind` enum is
 * enforced separately by {@link WorkflowNodeKindUnknownError} when
 * the substrate routes per-kind logic against a persisted row.
 */
export class WorkflowNodeKindShapeError extends WorkflowError {
  override readonly name = "WorkflowNodeKindShapeError";
  constructor(public readonly value: string) {
    super(`Invalid workflow node kind: "${value}" (must be a non-empty string)`);
  }
}

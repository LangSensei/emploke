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

import type { NodeKind } from "./types.js";

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
export class WorkflowNodeKindCorruptionError extends WorkflowError {
  override readonly name = "WorkflowNodeKindCorruptionError";
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
 * Thrown by `addNode(kind='coordinator')` / `addSubgraph` when a
 * coord-kind parent named in the insert's parent set already has a
 * coord-kind child node.
 *
 * Combined with the "inserted coord must have a coord-kind parent"
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
    public readonly coordParentNodeId: string,
  ) {
    super(
      `Coordinator node "${coordParentNodeId}" in workflow "${workflowId}" already has a coord-kind child; cannot add a second`,
    );
  }
}

/**
 * Thrown by `addNode(kind='coordinator')` / `addSubgraph` when the
 * inserted coordinator-kind node does NOT have any coordinator-kind
 * node in its parent set.
 *
 * Required for the coord-chain invariant: without this rule the
 * "≤1 coord successor per coord" check could be bypassed by adding
 * coord children to non-coord nodes. With this rule, every new coord
 * is structurally chained off an existing coord predecessor.
 */
export class OrphanCoordInsertError extends WorkflowError {
  override readonly name = "OrphanCoordInsertError";
  constructor(public readonly workflowId: string) {
    super(
      `Inserted coord node must have at least one coord-kind parent in workflow "${workflowId}"`,
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
 * existing DAG.
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
 * data-corruption error; the server's error-policy table maps to
 * 500 with an opaque body.
 */
export class WorkflowEnumValueCorruptionError extends WorkflowError {
  override readonly name = "WorkflowEnumValueCorruptionError";
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
 * non-empty string. Distinct from {@link WorkflowEnumValueCorruptionError}:
 * the entity-layer kind guard checks shape only (`assertValidXxx`
 * pattern); membership against the closed `NodeKind` enum is
 * enforced separately by {@link WorkflowNodeKindCorruptionError} when
 * the substrate routes per-kind logic against a persisted row.
 */
export class WorkflowNodeKindShapeError extends WorkflowError {
  override readonly name = "WorkflowNodeKindShapeError";
  constructor(public readonly value: string) {
    super(`Invalid workflow node kind: "${value}" (must be a non-empty string)`);
  }
}

// ─── Edge lookup ────────────────────────────────────────────────────

/**
 * Thrown by `removeEdge` when the `(fromNodeId, toNodeId)` pair does
 * not correspond to a live edge in the workflow. Distinct from
 * {@link WorkflowNodeNotFoundError} so callers can disambiguate
 * "endpoints exist, but the edge between them does not" from
 * "endpoints missing entirely".
 */
export class WorkflowEdgeNotFoundError extends WorkflowError {
  override readonly name = "WorkflowEdgeNotFoundError";
  constructor(
    public readonly workflowId: string,
    public readonly fromNodeId: string,
    public readonly toNodeId: string,
  ) {
    super(`Edge ${fromNodeId}→${toNodeId} not found in workflow "${workflowId}"`);
  }
}

// ─── Structural removal rules (removeNode / removeEdge) ─────────────

/**
 * Thrown by `removeNode` when deleting the node would leave one of
 * its children with zero parents. The substrate's structural rule:
 * every non-root node must retain ≥1 parent so phase / dispatch-
 * readiness semantics remain well-defined. The orphan check fires
 * BEFORE the row delete so the rejection uses the pre-delete edge
 * set; if the check rejected, no rows have been touched.
 */
export class WorkflowRemoveNodeOrphansChildError extends WorkflowError {
  override readonly name = "WorkflowRemoveNodeOrphansChildError";
  constructor(
    public readonly workflowId: string,
    public readonly nodeId: string,
    public readonly orphanedChildId: string,
  ) {
    super(
      `Removing node "${nodeId}" in workflow "${workflowId}" would orphan child "${orphanedChildId}" (zero remaining parents)`,
    );
  }
}

/**
 * Thrown by `removeEdge` when deleting the edge would leave the
 * to-node with zero parents. Same invariant as
 * {@link WorkflowRemoveNodeOrphansChildError} but scoped to a single
 * edge: only the to-node could lose its last parent, never any other
 * descendant.
 */
export class WorkflowRemoveEdgeOrphansChildError extends WorkflowError {
  override readonly name = "WorkflowRemoveEdgeOrphansChildError";
  constructor(
    public readonly workflowId: string,
    public readonly fromNodeId: string,
    public readonly toNodeId: string,
  ) {
    super(
      `Removing edge ${fromNodeId}→${toNodeId} in workflow "${workflowId}" would orphan to-node "${toNodeId}" (zero remaining parents)`,
    );
  }
}

// ─── DAG well-formedness invariant (workflow leaf frontier) ─────────

/**
 * Thrown by `addSubgraph` when applying the batch would leave the
 * workflow's structural leaf frontier (nodes with `out_degree=0`)
 * in a shape that violates the substrate's well-formedness invariant:
 * at any quiescent state the leaves must be exactly **{1 coord node}**.
 *
 * The structural payload (`actualLeafIds` / `actualLeafKinds`) lets
 * diagnostic output point the operator at the offending leaves
 * without re-querying. The error fires AFTER the batch's other gates
 * pass — a malformed cycle / orphan / etc. errors out earlier with
 * its own specific class.
 *
 * Low-level mutations (`addNode`, `addEdge`, `removeNode`,
 * `removeEdge`, `replaceNodeSpec`, `cancelNode`, `markNodeTerminal`)
 * deliberately do NOT validate this invariant pre-write — they're
 * sequenceable primitives and the substrate's stuck-coord detector
 * runs at the end of every mutation tx as a safety net. `addSubgraph`
 * is the one atomic-batch primitive where invariant violation cannot
 * be sequenced away, hence the upfront commit-time check.
 */
export class WorkflowDagInvariantError extends WorkflowError {
  override readonly name = "WorkflowDagInvariantError";
  constructor(
    public readonly workflowId: string,
    public readonly actualLeafIds: readonly string[],
    public readonly actualLeafKinds: readonly NodeKind[],
    message?: string,
  ) {
    super(
      message ??
        `Workflow "${workflowId}" violates DAG invariant: leaf frontier must be exactly {1 coordinator}, got ${actualLeafIds.length} leaves of kinds [${actualLeafKinds.join(", ")}]`,
    );
  }
}

// ─── Subgraph batch structural rules (addSubgraph) ──────────────────

/**
 * Thrown by `addSubgraph` when the `nodes` array is empty. Batch
 * inserts of zero nodes have no defensible interpretation — the
 * primitive would be a no-op that still consumed a write tx.
 * Rejecting at the boundary keeps callers honest.
 */
export class WorkflowSubgraphEmptyError extends WorkflowError {
  override readonly name = "WorkflowSubgraphEmptyError";
  constructor() {
    super("addSubgraph: nodes array must contain at least one entry");
  }
}

/**
 * Thrown by `addSubgraph` when a `tempId` is empty, blank, or
 * duplicated within the batch. The `reason` field carries the
 * specific violation (`"empty"`, `"duplicate \"foo\""`) so debugging
 * a rejected batch doesn't require re-running with extra logging.
 * One error class for both the empty and duplicate cases — they're
 * the same structural concern (`tempId` is the batch-local primary
 * key) at slightly different angles.
 */
export class WorkflowSubgraphTempIdInvalidError extends WorkflowError {
  override readonly name = "WorkflowSubgraphTempIdInvalidError";
  constructor(public readonly reason: string) {
    super(`addSubgraph: invalid tempId — ${reason}`);
  }
}

/**
 * Thrown by `addSubgraph` when a temp has zero parents (counting
 * both `existingParents` and intra-batch incoming temp-edges).
 * Mirrors {@link EmptyParentsError} for `addNode` — every node in
 * the workflow except the initial coord (allocated by
 * `createWorkflow`) must root in ≥1 parent so phase semantics and
 * dispatch readiness stay well-defined.
 */
export class WorkflowSubgraphTempParentlessError extends WorkflowError {
  override readonly name = "WorkflowSubgraphTempParentlessError";
  constructor(public readonly tempId: string) {
    super(`addSubgraph: temp "${tempId}" has zero parents (need ≥1 existing or intra-batch)`);
  }
}

/**
 * Thrown by `addSubgraph` when a `NodeRef` (in `edges[]` or
 * `existingParents[]`) does not resolve to a known node:
 *
 *   - `kind: "existing"`: the referenced id is not a node in this
 *     workflow.
 *   - `kind: "temp"`: the referenced tempId is not present in the
 *     batch's `nodes[*].tempId`.
 *
 * The `refKind` / `refValue` pair carries the specific reference
 * that failed so the rejection diagnostic is unambiguous.
 */
export class WorkflowSubgraphNodeRefUnresolvedError extends WorkflowError {
  override readonly name = "WorkflowSubgraphNodeRefUnresolvedError";
  constructor(
    public readonly workflowId: string,
    public readonly refKind: "existing" | "temp",
    public readonly refValue: string,
  ) {
    super(
      `addSubgraph: ${refKind} ref "${refValue}" did not resolve to a known node in workflow "${workflowId}"`,
    );
  }
}

/**
 * Thrown by `addSubgraph` when the proposed batch would create a
 * cycle — either within the intra-batch temp subgraph alone, or
 * across the joined DAG (existing nodes ∪ inserted temps). Distinct
 * from {@link WorkflowEdgeCycleError} (which `addEdge` throws for
 * a single new edge) because subgraph cycles can involve tempIds
 * that are not yet real node ids; the error reports the offending
 * (from, to) pair as the caller spelled it in the batch.
 */
export class WorkflowSubgraphCyclicError extends WorkflowError {
  override readonly name = "WorkflowSubgraphCyclicError";
  constructor(
    public readonly workflowId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`addSubgraph: edge ${from}→${to} would create a cycle in workflow "${workflowId}"`);
  }
}

/**
 * Thrown by `addSubgraph` when the batch declares more than one
 * coordinator-kind temp. Per the substrate's coord-chain invariant,
 * each dispatch may enqueue at most one successor coord; a batch
 * with 2 coord temps would violate that. Stricter than the inter-
 * batch single-successor rule (which {@link MultipleSuccessorCoordsError}
 * covers) because the inter-batch rule looks at each coord parent's
 * existing children only, not at the batch's own contents.
 */
export class WorkflowSubgraphMultipleCoordTempsError extends WorkflowError {
  override readonly name = "WorkflowSubgraphMultipleCoordTempsError";
  constructor(public readonly workflowId: string) {
    super(
      `addSubgraph: batch contains more than one coordinator-kind temp in workflow "${workflowId}"`,
    );
  }
}

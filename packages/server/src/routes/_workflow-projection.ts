/**
 * Wire-shape projection for workflow entities.
 *
 * The substrate stores `WorkflowEntity` (header) and
 * `WorkflowNodeEntity` (per-node) with an opaque `spec: unknown` on
 * the node — only the per-kind `WorkflowNodeRunner` knows the typed
 * shape. The wire DTOs in `@emploke/contracts` project that envelope
 * flat for the two shipped kinds (`task` / `coordinator`) and pass
 * any future kind through verbatim.
 *
 * Lives in the server pkg (not the substrate) because the projection
 * is wire-layer-specific — the substrate stays kind-agnostic and
 * takes no workspace dep on `@emploke/contracts`.
 */

import type {
  WorkflowDagWire,
  WorkflowEdgeWire,
  WorkflowHeaderWire,
  WorkflowNodeWire,
  WorkflowNodeWireSpec,
} from "@emploke/api";
import {
  deriveIterationCount,
  type WorkflowDagSnapshot,
  type WorkflowEdgeEntity,
  type WorkflowEntity,
  type WorkflowNodeEntity,
} from "@emploke/workflow";

/**
 * Project a `WorkflowEntity` to the wire-shape header. The caller
 * supplies `iterationCount` explicitly — list routes pass `0` (the
 * per-row coord-node count would be O(N) — see {@link
 * deriveIterationCount}); single-workflow routes pass the count
 * computed from a fresh `listNodesByWorkflow` call.
 */
export function projectWorkflowHeader(
  wf: WorkflowEntity,
  iterationCount: number,
): WorkflowHeaderWire {
  return {
    id: wf.id,
    brief: wf.brief,
    ...(wf.details !== undefined ? { details: wf.details } : {}),
    coordinatorAgent: wf.coordinatorAgent,
    status: wf.status,
    metadata: wf.metadata,
    iterationCount,
    createdAt: wf.createdAt,
    ...(wf.startedAt !== undefined ? { startedAt: wf.startedAt } : {}),
    ...(wf.endedAt !== undefined ? { endedAt: wf.endedAt } : {}),
  };
}

/**
 * Flatten the node-spec envelope for the two shipped kinds; pass any
 * future kind through as `{ kind, spec }` so dashboard / CLI code can
 * branch on the discriminator without unwrapping.
 *
 * The cast to the per-kind wire shape is safe because the substrate's
 * per-kind handler validates `spec` shape at insert time (see
 * `workflowTaskNodeHandler` / `workflowCoordinatorNodeHandler` in
 * `@emploke/api/wiring`). A schema-corrupted row would surface as a
 * runtime parse error from `WorkflowNodeEntity.fromRow` before
 * reaching this projection.
 */
function projectNodeSpec(node: WorkflowNodeEntity): WorkflowNodeWireSpec {
  if (node.kind === "worker") {
    return { kind: "task", ...(node.spec as object) } as WorkflowNodeWireSpec;
  }
  if (node.kind === "coordinator") {
    return { kind: "coordinator", ...(node.spec as object) } as WorkflowNodeWireSpec;
  }
  return { kind: node.kind, spec: node.spec };
}

/** Project a `WorkflowNodeEntity` to the wire-shape node. */
export function projectWorkflowNode(node: WorkflowNodeEntity): WorkflowNodeWire {
  return {
    id: node.id,
    workflowId: node.workflowId,
    phase: node.phase,
    status: node.status,
    spec: projectNodeSpec(node),
    createdAt: node.createdAt,
    ...(node.readyAt !== undefined ? { readyAt: node.readyAt } : {}),
    ...(node.runningAt !== undefined ? { runningAt: node.runningAt } : {}),
    ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
  };
}

/** Project a `WorkflowEdgeEntity` to its wire-shape `(from, to)` pair. */
export function projectWorkflowEdge(edge: WorkflowEdgeEntity): WorkflowEdgeWire {
  return { from: edge.from, to: edge.to };
}

/**
 * Project a full DAG snapshot. `iterationCount` is derived inline
 * from the snapshot's nodes (no extra query — the nodes are already
 * in hand). Mirrors {@link projectWorkflowHeader} for the header
 * field set.
 */
export function projectWorkflowDag(snapshot: WorkflowDagSnapshot): WorkflowDagWire {
  const coordCount = snapshot.nodes.filter((n) => n.kind === "coordinator").length;
  const iterationCount = deriveIterationCount(coordCount);
  return {
    workflow: projectWorkflowHeader(snapshot.workflow, iterationCount),
    nodes: snapshot.nodes.map(projectWorkflowNode),
    edges: snapshot.edges.map(projectWorkflowEdge),
  };
}

/**
 * Compute `iterationCount` for a single workflow by re-fetching its
 * node list. Used by the `GET /:wfid` header route. The dag route
 * uses {@link projectWorkflowDag} which derives it inline.
 */
export function iterationCountForNodes(nodes: readonly WorkflowNodeEntity[]): number {
  const coordCount = nodes.filter((n) => n.kind === "coordinator").length;
  return deriveIterationCount(coordCount);
}

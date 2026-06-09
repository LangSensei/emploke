/**
 * Pure DAG / entity helpers used by `workflow-service.ts`. Module-
 * private to the pkg: extracted here so the service stays focused on
 * the orchestration logic.
 *
 * Every function in this file is stateless and side-effect free —
 * no `this`, no I/O, no DB handle. They depend only on entity types,
 * the substrate's closed kind enum (`'coordinator' | 'worker'`),
 * and the error catalog.
 */

import {
  WorkflowError,
  WorkflowSubgraphMultipleCoordTempsError,
  WorkflowSubgraphNodeRefUnresolvedError,
  WorkflowSubgraphTempIdInvalidError,
  WorkflowSubgraphTempParentlessError,
} from "./errors.js";
import type { NodeKind, WorkflowNodeStatus } from "./types.js";
import { WorkflowEntity, WorkflowNodeEntity } from "./workflow-entity.js";

export const COORDINATOR_KIND: NodeKind = "coordinator";
export const WORKER_KIND: NodeKind = "worker";

const TERMINAL_NODE_STATUSES: ReadonlySet<WorkflowNodeStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function workflowEntityFor(args: {
  readonly id: string;
  readonly brief: string;
  readonly details: string | undefined;
  readonly coordinatorAgent: string;
  readonly nowIso: string;
}): WorkflowEntity {
  return WorkflowEntity.fromRow({
    id: args.id,
    brief: args.brief,
    details: args.details ?? null,
    coordinatorAgent: args.coordinatorAgent,
    status: "running",
    metadata: "{}",
    createdAt: args.nowIso,
    startedAt: args.nowIso,
    endedAt: null,
    success: null,
    failure: null,
    cancellation: null,
  });
}

export function nodeEntityFor(args: {
  readonly id: string;
  readonly workflowId: string;
  readonly kind: NodeKind;
  readonly spec: unknown;
  readonly phase: number;
  readonly status: WorkflowNodeStatus;
  readonly nowIso: string;
}): WorkflowNodeEntity {
  return WorkflowNodeEntity.fromRow({
    id: args.id,
    workflowId: args.workflowId,
    kind: args.kind,
    specJson: JSON.stringify(args.spec),
    phase: args.phase,
    status: args.status,
    createdAt: args.nowIso,
    readyAt: null,
    runningAt: null,
    endedAt: null,
  });
}

export function computePhaseFromParents(parents: readonly WorkflowNodeEntity[]): number {
  if (parents.length === 0) return 0;
  let maxPhase = -1;
  for (const p of parents) if (p.phase > maxPhase) maxPhase = p.phase;
  return maxPhase + 1;
}

export function parentsOf(
  nodeId: string,
  edges: readonly { readonly from: string; readonly to: string }[],
): string[] {
  return edges.filter((e) => e.to === nodeId).map((e) => e.from);
}

/**
 * Per-kind parent-readiness predicate. Closed over the substrate's
 * two known kinds:
 *
 *   - `worker`: every parent must be `succeeded` (a failed parent
 *     would block forever; the worker-kind contract demands all
 *     prerequisites complete cleanly).
 *   - `coordinator`: every parent must be in any terminal status
 *     (coord wakes on failures specifically to drive recovery).
 *
 * Exhaustive over `NodeKind`; the `never` branch is a
 * compile-time guarantee that any future enum extension surfaces
 * here.
 */
export function parentsReadyForKind(
  kind: NodeKind,
  parents: readonly WorkflowNodeEntity[],
): boolean {
  if (parents.length === 0) return true;
  switch (kind) {
    case "worker":
      return parents.every((p) => p.status === "succeeded");
    case "coordinator":
      return parents.every((p) => TERMINAL_NODE_STATUSES.has(p.status));
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return false;
    }
  }
}

export function wouldCreateCycle(
  edges: readonly { readonly from: string; readonly to: string }[],
  newEdge: { readonly from: string; readonly to: string },
): boolean {
  // Search for a path from newEdge.to back to newEdge.from in the
  // live DAG. If found, adding newEdge closes that loop. Skip the
  // trivial self-edge case explicitly.
  if (newEdge.from === newEdge.to) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const visited = new Set<string>();
  const stack: string[] = [newEdge.to];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === newEdge.from) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const n of adj.get(cur) ?? []) stack.push(n);
  }
  return false;
}

export function parseSpecJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new WorkflowError(
      `Failed to parse coord spec_json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── addSubgraph batch helpers (pure) ───────────────────────────────

/**
 * Discriminated-union reference to a node in an `addSubgraph` edge:
 *
 *   - `kind: "existing"`: real node id already persisted in this
 *     workflow.
 *   - `kind: "temp"`: a `tempId` declared in the batch's `nodes[]`,
 *     resolved to a real id during topology assignment.
 *
 * Exported here (pure module) so the service file and the public
 * `index.ts` re-export can pick it up without dragging in service-
 * level imports.
 */
export type NodeRef =
  | { readonly kind: "existing"; readonly id: string }
  | { readonly kind: "temp"; readonly tempId: string };

/**
 * Shape of one declared temp node in an `addSubgraph` batch (the
 * pure-helper view; the service-facing arg type adds nothing
 * beyond this). `existingParents` is optional in the public surface
 * but normalized to an empty array here for traversal simplicity.
 */
export interface SubgraphTempNodeShape {
  readonly tempId: string;
  readonly kind: NodeKind;
  readonly existingParents: readonly string[];
}

/**
 * Shape of one declared edge in an `addSubgraph` batch.
 */
export interface SubgraphEdgeShape {
  readonly from: NodeRef;
  readonly to: NodeRef;
}

/**
 * Pure structural validation for `addSubgraph`. Runs BEFORE any DB
 * access so a malformed batch is rejected without touching SQL:
 *
 *   1. Every `tempId` is a non-empty string AND unique within the
 *      batch (case-sensitive).
 *   2. At most one coord-kind temp in the batch (per coord-chain
 *      invariant — caller can have at most 1 successor coord; the
 *      batch's own coord-temp count is the strictest version of this
 *      rule and is enforced here at the batch boundary).
 *   3. Every `NodeRef.kind === "temp"` references a tempId declared
 *      in `nodes[*].tempId`.
 *   4. Every temp has ≥1 parent (existingParents.length + intra-batch
 *      incoming temp-edges where `from.kind === "temp"` and
 *      `to.kind === "temp"` with `to.tempId === temp.tempId`).
 *
 * Returns `void` on success; throws a subclass of `WorkflowError`
 * on the first violation found (no error aggregation — the caller
 * fixes one issue at a time).
 */
export function validateSubgraphShape(
  workflowId: string,
  nodes: readonly SubgraphTempNodeShape[],
  edges: readonly SubgraphEdgeShape[],
): void {
  const tempIds = new Set<string>();
  let coordCount = 0;
  for (const n of nodes) {
    if (typeof n.tempId !== "string" || n.tempId.length === 0) {
      throw new WorkflowSubgraphTempIdInvalidError("tempId must be a non-empty string");
    }
    if (tempIds.has(n.tempId)) {
      throw new WorkflowSubgraphTempIdInvalidError(`duplicate tempId "${n.tempId}"`);
    }
    tempIds.add(n.tempId);
    if (n.kind === "coordinator") coordCount++;
  }
  if (coordCount > 1) {
    throw new WorkflowSubgraphMultipleCoordTempsError(workflowId);
  }

  // Resolve every NodeRef.kind === "temp" against the declared set.
  // Existing-ref resolution requires DB access and is handled by the
  // service layer (see validateSubgraphAgainstWorkflow); here we only
  // catch references to undeclared temps.
  for (const e of edges) {
    if (e.from.kind === "temp" && !tempIds.has(e.from.tempId)) {
      throw new WorkflowSubgraphNodeRefUnresolvedError(workflowId, "temp", e.from.tempId);
    }
    if (e.to.kind === "temp" && !tempIds.has(e.to.tempId)) {
      throw new WorkflowSubgraphNodeRefUnresolvedError(workflowId, "temp", e.to.tempId);
    }
  }

  // Parentless-temp guard. Combined parent-count = existingParents.length
  // plus intra-batch incoming temp-edges.
  const intraIncoming = new Map<string, number>();
  for (const t of tempIds) intraIncoming.set(t, 0);
  for (const e of edges) {
    if (e.from.kind === "temp" && e.to.kind === "temp") {
      intraIncoming.set(e.to.tempId, (intraIncoming.get(e.to.tempId) ?? 0) + 1);
    }
  }
  for (const n of nodes) {
    const parentCount = n.existingParents.length + (intraIncoming.get(n.tempId) ?? 0);
    if (parentCount === 0) {
      throw new WorkflowSubgraphTempParentlessError(n.tempId);
    }
  }
}

/**
 * Shape returned by {@link normalizeSubgraphInput}. Carries the same
 * `SubgraphTempNodeShape` / `SubgraphEdgeShape` arrays but with
 * duplicates collapsed:
 *
 *   - Each temp's `existingParents` is deduped via `Array.from(new Set(...))`.
 *   - The `edges[]` array is deduped by the `(from, to)` pair under
 *     the {@link NodeRef} discriminator (two `existing→existing` edges
 *     with the same ids collapse; two `temp→temp` edges with the same
 *     tempIds collapse; mixed `temp→existing` and `existing→temp`
 *     never collapse with anything since their keys differ).
 *
 * The substrate's downstream topology + insert logic always sees the
 * normalized form so a caller passing a duplicate ref does not trip
 * the SQLite composite-PK constraint as a generic error. Matches the
 * sibling pattern in `addNode` (`Array.from(new Set(args.parents))`).
 */
export interface NormalizedSubgraphInput {
  readonly nodes: readonly SubgraphTempNodeShape[];
  readonly edges: readonly SubgraphEdgeShape[];
}

function serializeNodeRef(ref: NodeRef): string {
  return ref.kind === "existing" ? `existing:${ref.id}` : `temp:${ref.tempId}`;
}

export function normalizeSubgraphInput(input: {
  readonly nodes: readonly SubgraphTempNodeShape[];
  readonly edges: readonly SubgraphEdgeShape[];
}): NormalizedSubgraphInput {
  const nodes: SubgraphTempNodeShape[] = input.nodes.map((n) => ({
    tempId: n.tempId,
    kind: n.kind,
    existingParents: Array.from(new Set(n.existingParents)),
  }));
  const seen = new Set<string>();
  const edges: SubgraphEdgeShape[] = [];
  for (const e of input.edges) {
    const key = `${serializeNodeRef(e.from)}->${serializeNodeRef(e.to)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: e.from, to: e.to });
  }
  return { nodes, edges };
}

/**
 * Pure topological sort of the temp subgraph. Returns the temps in
 * an order such that every intra-batch parent appears before its
 * children. Tie-breaks by `tempId` lexicographic order so the
 * returned order is deterministic across runs — tests and callers
 * can rely on it.
 *
 * Throws when the intra-batch graph has a cycle (the caller should
 * have caught duplicate tempIds first; the cycle check here only
 * triggers on a genuine back-edge among temps).
 */
export function resolveSubgraphTopology(
  workflowId: string,
  nodes: readonly SubgraphTempNodeShape[],
  edges: readonly SubgraphEdgeShape[],
): readonly SubgraphTempNodeShape[] {
  // Build intra-batch adjacency (temp → temp only). Existing-temp and
  // temp-existing edges don't affect intra-batch ordering.
  const byTempId = new Map<string, SubgraphTempNodeShape>();
  for (const n of nodes) byTempId.set(n.tempId, n);

  const inDeg = new Map<string, number>();
  const outAdj = new Map<string, string[]>();
  for (const t of byTempId.keys()) {
    inDeg.set(t, 0);
    outAdj.set(t, []);
  }
  for (const e of edges) {
    if (e.from.kind === "temp" && e.to.kind === "temp") {
      outAdj.get(e.from.tempId)!.push(e.to.tempId);
      inDeg.set(e.to.tempId, (inDeg.get(e.to.tempId) ?? 0) + 1);
    }
  }

  // Kahn's algorithm with deterministic tiebreaker. The ready set is
  // kept sorted on each pop so the lexicographically smallest temp
  // ready at any moment ships first.
  const ready: string[] = [];
  for (const [t, d] of inDeg) if (d === 0) ready.push(t);
  ready.sort();

  const order: SubgraphTempNodeShape[] = [];
  while (ready.length > 0) {
    const cur = ready.shift() as string;
    const node = byTempId.get(cur);
    if (node !== undefined) order.push(node);
    const children = outAdj.get(cur) ?? [];
    children.sort();
    for (const c of children) {
      const d = (inDeg.get(c) ?? 0) - 1;
      inDeg.set(c, d);
      if (d === 0) {
        // Insert keeping `ready` sorted. Small arrays — linear is fine.
        let i = 0;
        while (i < ready.length && ready[i]! < c) i++;
        ready.splice(i, 0, c);
      }
    }
  }
  if (order.length !== nodes.length) {
    // A cycle ate at least one temp. Report the first surviving back-
    // edge by re-scanning the unprocessed set.
    const processed = new Set(order.map((n) => n.tempId));
    for (const e of edges) {
      if (e.from.kind === "temp" && e.to.kind === "temp") {
        if (!processed.has(e.from.tempId) && !processed.has(e.to.tempId)) {
          throw new WorkflowError(
            `addSubgraph: intra-batch cycle in workflow "${workflowId}" involves temps "${e.from.tempId}" and "${e.to.tempId}"`,
          );
        }
      }
    }
    // Defensive — shouldn't reach here if Kahn dropped a temp.
    throw new WorkflowError(
      `addSubgraph: intra-batch cycle in workflow "${workflowId}" (${nodes.length - order.length} temps unresolved)`,
    );
  }
  return order;
}

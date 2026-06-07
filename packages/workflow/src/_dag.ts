/**
 * Pure DAG / entity helpers used by `workflow-service.ts`. Module-
 * private to the pkg: extracted here so the service stays focused on
 * the orchestration logic.
 *
 * Every function in this file is stateless and side-effect free —
 * no `this`, no I/O, no DB handle. They depend only on entity types,
 * the substrate's two known kinds (`task` / `coordinator`), and the
 * error catalog.
 */

import { WorkflowError, WorkflowNodeKindUnknownError } from "./errors.js";
import type { WorkflowNodeStatus } from "./types.js";
import { WorkflowEntity, WorkflowNodeEntity } from "./workflow-entity.js";

const COORDINATOR_KIND = "coordinator";
const TASK_KIND = "task";

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
  });
}

export function nodeEntityFor(args: {
  readonly id: string;
  readonly workflowId: string;
  readonly kind: string;
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
 * Per-kind parent-readiness predicate. The substrate's two known
 * kinds:
 *   - `task`: every parent must be `succeeded` (a failed parent
 *     would block forever; the task-kind contract demands all
 *     prerequisites complete cleanly).
 *   - `coordinator`: every parent must be in any terminal status
 *     (coord wakes on failures specifically to drive recovery).
 *
 * Any other kind throws — kind-handler registration covers the
 * substrate's storage / dispatch concerns, but the parent-readiness
 * rule is one of the two strings hard-coded in the substrate.
 */
export function parentsReadyForKind(kind: string, parents: readonly WorkflowNodeEntity[]): boolean {
  if (parents.length === 0) return true;
  if (kind === TASK_KIND) {
    return parents.every((p) => p.status === "succeeded");
  }
  if (kind === COORDINATOR_KIND) {
    return parents.every((p) => TERMINAL_NODE_STATUSES.has(p.status));
  }
  throw new WorkflowNodeKindUnknownError(kind);
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

import { Workflow } from "./entity.js";
import { WorkflowNodeNotFoundError, WorkflowNotFoundError } from "./errors.js";
import type { WorkflowsRepository } from "./repository.js";
import type {
  CreateNodeArgs,
  CreateWorkflowArgs,
  NodeResultPatch,
  TaskDispatcher,
  Workflow as WorkflowDTO,
  WorkflowEdge as WorkflowEdgeDTO,
  WorkflowNode as WorkflowNodeDTO,
  WorkflowOutcome,
  WorkflowState,
} from "./types.js";
import {
  assertValidWorkflowId,
  assertValidWorkflowNodeId,
  generateWorkflowId,
  generateWorkflowNodeId,
} from "./validate.js";

/**
 * Orchestrator-facing tool surface for `@emploke/workflows`.
 *
 * Eight tools, per TASK.md §3:
 *
 *   1. createWorkflow(brief, details?, metadata?)
 *   2. createNode(workflowId, type, spec)
 *   3. addEdge(workflowId, from, to)
 *   4. launchNode(workflowId, nodeId)   — dispatches the backing task
 *   5. markDone(workflowId, nodeId, result)
 *   6. markFailed(workflowId, nodeId, error)
 *   7. finishWorkflow(workflowId, outcome)
 *   8. cancelNode(workflowId, nodeId)   — hard-guarded to `not_started`
 *
 * Plus read methods (`get`, `getState`, `list`) for the future HTTP
 * route layer (M4).
 *
 * All state-machine logic lives on `Workflow` — the service is a
 * thin orchestrator that loads the aggregate, calls the matching
 * `with*` method, persists, and projects to wire DTOs. The substrate
 * is the source of truth for the FSM and the DAG; this class never
 * branches on `status` independently of the entity.
 */
export class WorkflowsService {
  private readonly repo: WorkflowsRepository;
  private readonly taskDispatcher: TaskDispatcher;
  private readonly now: () => Date;

  constructor(opts: {
    readonly repo: WorkflowsRepository;
    readonly taskDispatcher: TaskDispatcher;
    readonly now?: () => Date;
  }) {
    this.repo = opts.repo;
    this.taskDispatcher = opts.taskDispatcher;
    this.now = opts.now ?? (() => new Date());
  }

  // ─── Reads ────────────────────────────────────────────────

  async get(id: string): Promise<WorkflowDTO | null> {
    const wf = await this.repo.read(id);
    return wf === null ? null : toWorkflowDto(wf);
  }

  async getState(id: string): Promise<WorkflowState | null> {
    const wf = await this.repo.read(id);
    return wf === null ? null : toWorkflowState(wf);
  }

  async list(): Promise<WorkflowDTO[]> {
    const wfs = await this.repo.list();
    return wfs.map(toWorkflowDto);
  }

  // ─── Writes — graph construction ──────────────────────────

  async createWorkflow(args: CreateWorkflowArgs): Promise<WorkflowDTO> {
    const id = args.id ?? generateWorkflowId(this.now);
    assertValidWorkflowId(id);
    const wf = Workflow.create({
      id,
      brief: args.brief,
      ...(args.details !== undefined ? { details: args.details } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      createdAt: this.now().toISOString(),
    });
    await this.repo.save(wf);
    return toWorkflowDto(wf);
  }

  async createNode(workflowId: string, args: CreateNodeArgs): Promise<WorkflowNodeDTO> {
    assertValidWorkflowId(workflowId);
    const wf = await this.requireWorkflow(workflowId);
    const nodeId = args.id ?? generateWorkflowNodeId(this.now);
    assertValidWorkflowNodeId(nodeId);
    const next = wf.addNode({
      id: nodeId,
      type: args.type,
      spec: args.spec,
      createdAt: this.now().toISOString(),
    });
    await this.repo.save(next);
    const node = next.node(nodeId);
    if (node === undefined) {
      // Defensive — Workflow.addNode just inserted it.
      throw new WorkflowNodeNotFoundError(workflowId, nodeId);
    }
    return toNodeDto(node);
  }

  async addEdge(workflowId: string, from: string, to: string): Promise<WorkflowEdgeDTO> {
    assertValidWorkflowId(workflowId);
    assertValidWorkflowNodeId(from);
    assertValidWorkflowNodeId(to);
    const wf = await this.requireWorkflow(workflowId);
    const next = wf.addEdge(from, to);
    await this.repo.save(next);
    return { workflowId, from, to };
  }

  // ─── Writes — lifecycle ───────────────────────────────────

  /**
   * Promote `nodeId` to `running` and dispatch the backing task via
   * the injected {@link TaskDispatcher}. The dispatched task's id is
   * stamped into `node.data.task_id` so the orchestrator can correlate
   * later `markDone`/`markFailed` calls back to a real task row.
   *
   * Order matters: persist the `running` transition BEFORE dispatch.
   * If dispatch crashes the substrate stays consistent (the node is
   * `running` with no `task_id`; the orchestrator can `markFailed`
   * to record the dispatch error). If we dispatched first and the
   * save crashed, we'd have a live subprocess with no record.
   */
  async launchNode(workflowId: string, nodeId: string): Promise<WorkflowNodeDTO> {
    assertValidWorkflowId(workflowId);
    assertValidWorkflowNodeId(nodeId);
    const wf = await this.requireWorkflow(workflowId);
    const node = wf.node(nodeId);
    if (node === undefined) throw new WorkflowNodeNotFoundError(workflowId, nodeId);

    const launchedAt = this.now().toISOString();
    const next = wf.launchNode(nodeId, launchedAt);
    await this.repo.save(next);

    // Dispatch outside the persisted-state-change boundary.
    const spec = node.spec as {
      readonly agent: string;
      readonly brief: string;
      readonly details?: string;
      readonly runtime?: string;
    };
    const task = await this.taskDispatcher.dispatch({
      agent: spec.agent,
      brief: spec.brief,
      ...(spec.details !== undefined ? { details: spec.details } : {}),
      ...(spec.runtime !== undefined ? { runtime: spec.runtime } : {}),
      origin: "workflow",
    });

    // Re-load and patch data.task_id (preserves the running status
    // we just set above).
    const loaded = await this.requireWorkflow(workflowId);
    const withTaskId = loaded.patchNodeData(nodeId, { task_id: task.id });
    await this.repo.save(withTaskId);
    const finalNode = withTaskId.node(nodeId);
    if (finalNode === undefined) throw new WorkflowNodeNotFoundError(workflowId, nodeId);
    return toNodeDto(finalNode);
  }

  async markDone(
    workflowId: string,
    nodeId: string,
    result: NodeResultPatch,
  ): Promise<WorkflowNodeDTO> {
    assertValidWorkflowId(workflowId);
    assertValidWorkflowNodeId(nodeId);
    const wf = await this.requireWorkflow(workflowId);
    const next = wf.markNodeDone(nodeId, result, this.now().toISOString());
    await this.repo.save(next);
    const node = next.node(nodeId);
    if (node === undefined) throw new WorkflowNodeNotFoundError(workflowId, nodeId);
    return toNodeDto(node);
  }

  async markFailed(
    workflowId: string,
    nodeId: string,
    error: NodeResultPatch,
  ): Promise<WorkflowNodeDTO> {
    assertValidWorkflowId(workflowId);
    assertValidWorkflowNodeId(nodeId);
    const wf = await this.requireWorkflow(workflowId);
    const next = wf.markNodeFailed(nodeId, error, this.now().toISOString());
    await this.repo.save(next);
    const node = next.node(nodeId);
    if (node === undefined) throw new WorkflowNodeNotFoundError(workflowId, nodeId);
    return toNodeDto(node);
  }

  async cancelNode(
    workflowId: string,
    nodeId: string,
    cancellation: NodeResultPatch = {},
  ): Promise<WorkflowNodeDTO> {
    assertValidWorkflowId(workflowId);
    assertValidWorkflowNodeId(nodeId);
    const wf = await this.requireWorkflow(workflowId);
    const next = wf.cancelNode(nodeId, cancellation, this.now().toISOString());
    await this.repo.save(next);
    const node = next.node(nodeId);
    if (node === undefined) throw new WorkflowNodeNotFoundError(workflowId, nodeId);
    return toNodeDto(node);
  }

  async finishWorkflow(workflowId: string, outcome: WorkflowOutcome): Promise<WorkflowDTO> {
    assertValidWorkflowId(workflowId);
    const wf = await this.requireWorkflow(workflowId);
    const next = wf.archive(outcome, this.now().toISOString());
    await this.repo.save(next);
    return toWorkflowDto(next);
  }

  // ─── internals ────────────────────────────────────────────

  private async requireWorkflow(id: string): Promise<Workflow> {
    const wf = await this.repo.read(id);
    if (wf === null) throw new WorkflowNotFoundError(id);
    return wf;
  }
}

// ─── DTO projection helpers ─────────────────────────────────

function toWorkflowDto(wf: Workflow): WorkflowDTO {
  return {
    id: wf.id,
    brief: wf.brief,
    ...(wf.details !== undefined ? { details: wf.details } : {}),
    status: wf.status,
    ...(wf.outcome !== undefined ? { outcome: wf.outcome } : {}),
    metadata: wf.metadata,
    createdAt: wf.createdAt,
    ...(wf.startedAt !== undefined ? { startedAt: wf.startedAt } : {}),
    ...(wf.archivedAt !== undefined ? { archivedAt: wf.archivedAt } : {}),
  };
}

function toNodeDto(n: ReturnType<Workflow["node"]> & object): WorkflowNodeDTO {
  return {
    id: n.id,
    workflowId: n.workflowId,
    type: n.type,
    status: n.status,
    spec: n.spec,
    data: n.data,
    createdAt: n.createdAt,
    ...(n.readyAt !== undefined ? { readyAt: n.readyAt } : {}),
    ...(n.runningAt !== undefined ? { runningAt: n.runningAt } : {}),
    ...(n.endedAt !== undefined ? { endedAt: n.endedAt } : {}),
  };
}

function toWorkflowState(wf: Workflow): WorkflowState {
  return {
    workflow: toWorkflowDto(wf),
    nodes: wf.nodes.map(toNodeDto),
    edges: wf.edges.map((e) => ({ workflowId: wf.id, from: e.from, to: e.to })),
  };
}

import {
  CorruptedWorkflowError,
  InvalidWorkflowTransitionError,
  WorkflowCycleError,
  WorkflowNodeNotReadyError,
} from "./errors.js";
import type {
  TaskNodeSpec,
  WorkflowNodeStatus,
  WorkflowNodeType,
  WorkflowOutcome,
  WorkflowStatus,
} from "./types.js";
import { WORKFLOW_ID_RE, WORKFLOW_NODE_ID_RE } from "./validate.js";

/**
 * Pure value-object representation of a workflow + every node + every
 * edge. This is the in-memory shape repositories return; the service
 * mutates by calling `with*` factories that produce fresh `Workflow`
 * values (immutable + structural-sharing-friendly).
 *
 * All five invariants from `TASK.md §4` are encoded here, with
 * `throw-on-violation` semantics:
 *
 *   1. DAG — cycle rejection on every `addEdge`.
 *   2. Append-only nodes — no removal API.
 *   3. Node FSM — strictly forward (`not_started → ready → running →
 *      succeeded|failed`); `cancelled` reachable only from
 *      `not_started`.
 *   4. Edges immutable once added.
 *   5. A node can only be launched when every upstream node is
 *      `succeeded`.
 *
 * `Repository.save` calls `Workflow.assertInvariants()` before write
 * — defense in depth so a future mis-use of the value-objects can't
 * persist a corrupted graph.
 */

const VALID_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  "not_started",
  "running",
  "idle",
  "archived",
]);
const VALID_NODE_STATUSES = new Set<WorkflowNodeStatus>([
  "not_started",
  "ready",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const VALID_OUTCOMES = new Set<WorkflowOutcome>(["succeeded", "failed", "cancelled"]);
const VALID_NODE_TYPES = new Set<WorkflowNodeType>(["task"]);

/** Terminal node statuses — any mutation past these throws. */
const NODE_TERMINAL_STATUSES = new Set<WorkflowNodeStatus>(["succeeded", "failed", "cancelled"]);

/** Immutable value object for one DAG edge. */
export interface WorkflowEdgeValue {
  readonly from: string;
  readonly to: string;
}

/** Immutable value object for one node. */
export class WorkflowNodeValue {
  constructor(
    readonly id: string,
    readonly workflowId: string,
    readonly type: WorkflowNodeType,
    readonly status: WorkflowNodeStatus,
    readonly spec: Readonly<Record<string, unknown>>,
    readonly data: Readonly<Record<string, unknown>>,
    readonly createdAt: string,
    readonly readyAt: string | undefined,
    readonly runningAt: string | undefined,
    readonly endedAt: string | undefined,
  ) {}

  withStatus(
    status: WorkflowNodeStatus,
    stamps: { readyAt?: string; runningAt?: string; endedAt?: string } = {},
    dataPatch?: Readonly<Record<string, unknown>>,
  ): WorkflowNodeValue {
    return new WorkflowNodeValue(
      this.id,
      this.workflowId,
      this.type,
      status,
      this.spec,
      dataPatch !== undefined ? Object.freeze({ ...this.data, ...dataPatch }) : this.data,
      this.createdAt,
      stamps.readyAt ?? this.readyAt,
      stamps.runningAt ?? this.runningAt,
      stamps.endedAt ?? this.endedAt,
    );
  }
}

/**
 * Aggregate root for one workflow: brief/details/status + all nodes
 * + all edges, in memory. Repositories hydrate / persist the whole
 * thing; the service mutates by replacing `this` with the result of
 * a `with*` call.
 *
 * State transitions live as instance methods so the FSM is checked
 * at the source — `service.markDone` is a thin orchestrator on top
 * of `workflow.markNodeDone(...)`.
 */
export class Workflow {
  private constructor(
    private readonly _id: string,
    private readonly _brief: string,
    private readonly _details: string | undefined,
    private readonly _status: WorkflowStatus,
    private readonly _outcome: WorkflowOutcome | undefined,
    private readonly _metadata: Readonly<Record<string, unknown>>,
    private readonly _createdAt: string,
    private readonly _startedAt: string | undefined,
    private readonly _archivedAt: string | undefined,
    private readonly _nodes: ReadonlyMap<string, WorkflowNodeValue>,
    private readonly _edges: readonly WorkflowEdgeValue[],
  ) {}

  // ─── construction ────────────────────────────────────────

  static create(args: {
    readonly id: string;
    readonly brief: string;
    readonly details?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  }): Workflow {
    if (!WORKFLOW_ID_RE.test(args.id)) {
      throw new CorruptedWorkflowError(args.id, "invalid workflow id format");
    }
    if (typeof args.brief !== "string" || args.brief.length === 0) {
      throw new CorruptedWorkflowError(args.id, "brief must be a non-empty string");
    }
    return new Workflow(
      args.id,
      args.brief,
      args.details,
      "not_started",
      undefined,
      Object.freeze({ ...(args.metadata ?? {}) }),
      args.createdAt,
      undefined,
      undefined,
      new Map(),
      [],
    );
  }

  static fromStored(args: {
    readonly id: string;
    readonly brief: string;
    readonly details?: string;
    readonly status: WorkflowStatus;
    readonly outcome?: WorkflowOutcome;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly startedAt?: string;
    readonly archivedAt?: string;
    readonly nodes: readonly WorkflowNodeValue[];
    readonly edges: readonly WorkflowEdgeValue[];
  }): Workflow {
    if (!WORKFLOW_ID_RE.test(args.id)) {
      throw new CorruptedWorkflowError(args.id, "invalid workflow id format");
    }
    if (!VALID_WORKFLOW_STATUSES.has(args.status)) {
      throw new CorruptedWorkflowError(
        args.id,
        `workflow.status must be one of ${[...VALID_WORKFLOW_STATUSES].join(", ")}`,
      );
    }
    if (args.outcome !== undefined && !VALID_OUTCOMES.has(args.outcome)) {
      throw new CorruptedWorkflowError(
        args.id,
        `workflow.outcome must be one of ${[...VALID_OUTCOMES].join(", ")}`,
      );
    }
    const nodeMap = new Map<string, WorkflowNodeValue>();
    for (const n of args.nodes) {
      if (!WORKFLOW_NODE_ID_RE.test(n.id)) {
        throw new CorruptedWorkflowError(args.id, `invalid node id: ${n.id}`);
      }
      if (!VALID_NODE_TYPES.has(n.type)) {
        throw new CorruptedWorkflowError(args.id, `node.type must be 'task', got '${n.type}'`);
      }
      if (!VALID_NODE_STATUSES.has(n.status)) {
        throw new CorruptedWorkflowError(
          args.id,
          `node.status must be one of ${[...VALID_NODE_STATUSES].join(", ")}`,
        );
      }
      nodeMap.set(n.id, n);
    }
    const wf = new Workflow(
      args.id,
      args.brief,
      args.details,
      args.status,
      args.outcome,
      Object.freeze({ ...args.metadata }),
      args.createdAt,
      args.startedAt,
      args.archivedAt,
      nodeMap,
      [...args.edges],
    );
    wf.assertInvariants();
    return wf;
  }

  // ─── accessors ──────────────────────────────────────────

  get id(): string {
    return this._id;
  }
  get brief(): string {
    return this._brief;
  }
  get details(): string | undefined {
    return this._details;
  }
  get status(): WorkflowStatus {
    return this._status;
  }
  get outcome(): WorkflowOutcome | undefined {
    return this._outcome;
  }
  get metadata(): Readonly<Record<string, unknown>> {
    return this._metadata;
  }
  get createdAt(): string {
    return this._createdAt;
  }
  get startedAt(): string | undefined {
    return this._startedAt;
  }
  get archivedAt(): string | undefined {
    return this._archivedAt;
  }
  get nodes(): readonly WorkflowNodeValue[] {
    return [...this._nodes.values()];
  }
  get edges(): readonly WorkflowEdgeValue[] {
    return this._edges;
  }

  node(id: string): WorkflowNodeValue | undefined {
    return this._nodes.get(id);
  }

  /** Upstream node ids that point INTO `nodeId`. */
  upstreamOf(nodeId: string): readonly string[] {
    return this._edges.filter((e) => e.to === nodeId).map((e) => e.from);
  }

  /** Downstream node ids that `nodeId` points TO. */
  downstreamOf(nodeId: string): readonly string[] {
    return this._edges.filter((e) => e.from === nodeId).map((e) => e.to);
  }

  // ─── mutators (return fresh Workflow values) ────────────

  addNode(args: {
    readonly id: string;
    readonly type: WorkflowNodeType;
    readonly spec: TaskNodeSpec;
    readonly createdAt: string;
  }): Workflow {
    if (!WORKFLOW_NODE_ID_RE.test(args.id)) {
      throw new CorruptedWorkflowError(this._id, `invalid node id: ${args.id}`);
    }
    if (this._nodes.has(args.id)) {
      throw new CorruptedWorkflowError(this._id, `node ${args.id} already exists`);
    }
    if (!VALID_NODE_TYPES.has(args.type)) {
      throw new InvalidWorkflowTransitionError(
        "workflow",
        "createNode",
        `type must be 'task' in v1, got '${args.type}'`,
      );
    }
    if (this._status === "archived") {
      throw new InvalidWorkflowTransitionError(this._status, "createNode", "workflow is archived");
    }
    assertTaskNodeSpec(args.spec);
    const node = new WorkflowNodeValue(
      args.id,
      this._id,
      args.type,
      "not_started",
      Object.freeze({ ...args.spec } as Record<string, unknown>),
      Object.freeze({}),
      args.createdAt,
      undefined,
      undefined,
      undefined,
    );
    const nodes = new Map(this._nodes);
    nodes.set(node.id, node);
    return this.replace({ nodes });
  }

  /**
   * Add a DAG edge between two existing nodes. Throws
   * {@link WorkflowCycleError} if the edge would introduce a cycle,
   * {@link CorruptedWorkflowError} if either endpoint is unknown or
   * the edge already exists, and {@link InvalidWorkflowTransitionError}
   * if the downstream node is no longer `not_started` (edges are
   * immutable post-launch — wiring a successor onto a running node
   * would violate the "ready when upstream succeeded" invariant).
   */
  addEdge(from: string, to: string): Workflow {
    if (from === to) {
      throw new WorkflowCycleError(this._id, from, to);
    }
    const fromNode = this._nodes.get(from);
    const toNode = this._nodes.get(to);
    if (fromNode === undefined) {
      throw new CorruptedWorkflowError(this._id, `addEdge: from node ${from} does not exist`);
    }
    if (toNode === undefined) {
      throw new CorruptedWorkflowError(this._id, `addEdge: to node ${to} does not exist`);
    }
    if (toNode.status !== "not_started") {
      throw new InvalidWorkflowTransitionError(
        toNode.status,
        "addEdge",
        `cannot add upstream edge: node ${to} is no longer 'not_started'`,
      );
    }
    if (this._edges.some((e) => e.from === from && e.to === to)) {
      throw new CorruptedWorkflowError(this._id, `addEdge: edge ${from}->${to} already exists`);
    }
    // DFS reach check: does `to` already reach `from`? If yes, adding
    // from→to closes a cycle.
    if (this.reaches(to, from)) {
      throw new WorkflowCycleError(this._id, from, to);
    }
    return this.replace({ edges: [...this._edges, { from, to }] });
  }

  /**
   * Stamp a node as `running` (or `ready` first if it hadn't been
   * auto-promoted). The service does the actual task dispatch — this
   * just records the transition. CEO O5: only `not_started` (after
   * promotion) and `ready` may transition; `running` and terminals
   * throw.
   */
  launchNode(nodeId: string, now: string): Workflow {
    const node = this.requireNode(nodeId);
    // Auto-promote not_started → ready when deps satisfied.
    let current = node;
    if (current.status === "not_started") {
      this.assertReady(current);
      current = current.withStatus("ready", { readyAt: now });
    }
    if (current.status !== "ready") {
      throw new InvalidWorkflowTransitionError(current.status, "launchNode");
    }
    this.assertReady(current);
    const promoted = current.withStatus("running", { runningAt: now });
    const nodes = new Map(this._nodes);
    nodes.set(promoted.id, promoted);
    // Workflow first launch stamps started_at + transitions to running.
    const wfPatch: Partial<{
      status: WorkflowStatus;
      startedAt: string;
    }> = {};
    if (this._startedAt === undefined) wfPatch.startedAt = now;
    if (this._status === "not_started" || this._status === "idle") wfPatch.status = "running";
    return this.replace({ nodes, ...wfPatch });
  }

  /**
   * Stamp `nodeId` as `succeeded`, merge `result` into `data`, and
   * auto-promote every downstream node whose upstream deps are now
   * all `succeeded` from `not_started → ready`.
   */
  markNodeDone(nodeId: string, result: Readonly<Record<string, unknown>>, now: string): Workflow {
    const node = this.requireNode(nodeId);
    if (node.status !== "running") {
      throw new InvalidWorkflowTransitionError(node.status, "markDone");
    }
    const updated = node.withStatus("succeeded", { endedAt: now }, result);
    const nodes = new Map(this._nodes);
    nodes.set(updated.id, updated);
    // Auto-promote any downstream node whose ALL upstream are now
    // succeeded.
    for (const down of this.downstreamOf(updated.id)) {
      const downNode = nodes.get(down);
      if (downNode === undefined || downNode.status !== "not_started") continue;
      const ups = this.upstreamOf(down);
      const allUpSucceeded = ups.every((u) => {
        const n = nodes.get(u);
        return n !== undefined && n.status === "succeeded";
      });
      if (allUpSucceeded) {
        nodes.set(down, downNode.withStatus("ready", { readyAt: now }));
      }
    }
    // Workflow transitions: if it was idle but a node is now ready/running,
    // the orchestrator decides what to do next. Substrate keeps status
    // = 'running' unless every node is terminal — then 'idle'.
    const wfPatch: Partial<{ status: WorkflowStatus }> = {};
    if (this.everyNodeTerminal(nodes)) wfPatch.status = "idle";
    return this.replace({ nodes, ...wfPatch });
  }

  /**
   * Stamp `nodeId` as `failed`. Per CEO O5 NO cascade — downstream
   * nodes stay `not_started`; the orchestrator chooses whether to
   * archive the workflow.
   */
  markNodeFailed(
    nodeId: string,
    failure: Readonly<Record<string, unknown>>,
    now: string,
  ): Workflow {
    const node = this.requireNode(nodeId);
    if (node.status !== "running") {
      throw new InvalidWorkflowTransitionError(node.status, "markFailed");
    }
    const updated = node.withStatus("failed", { endedAt: now }, failure);
    const nodes = new Map(this._nodes);
    nodes.set(updated.id, updated);
    const wfPatch: Partial<{ status: WorkflowStatus }> = {};
    if (this.everyNodeTerminal(nodes)) wfPatch.status = "idle";
    return this.replace({ nodes, ...wfPatch });
  }

  /**
   * Cancel a node. Per CEO O5 cancellation is only legal from
   * `not_started`. The TASK.md brief explicitly chose to keep the
   * tool in v1 with a hard guard rather than drop it entirely.
   */
  cancelNode(
    nodeId: string,
    cancellation: Readonly<Record<string, unknown>>,
    now: string,
  ): Workflow {
    const node = this.requireNode(nodeId);
    if (node.status !== "not_started") {
      throw new InvalidWorkflowTransitionError(
        node.status,
        "cancelNode",
        "cancellation is only legal from 'not_started' (CEO O5)",
      );
    }
    const updated = node.withStatus("cancelled", { endedAt: now }, cancellation);
    const nodes = new Map(this._nodes);
    nodes.set(updated.id, updated);
    return this.replace({ nodes });
  }

  /**
   * Stamp the workflow as `archived` with `outcome`. Forward-only:
   * a workflow that is already `archived` rejects further
   * `finishWorkflow` calls.
   */
  archive(outcome: WorkflowOutcome, now: string): Workflow {
    if (this._status === "archived") {
      throw new InvalidWorkflowTransitionError(this._status, "finishWorkflow");
    }
    if (!VALID_OUTCOMES.has(outcome)) {
      throw new InvalidWorkflowTransitionError(
        this._status,
        "finishWorkflow",
        `unknown outcome ${outcome}`,
      );
    }
    return this.replace({
      status: "archived",
      outcome,
      archivedAt: now,
    });
  }

  /**
   * Merge `patch` into `nodeId`'s `data` JSON without touching the
   * node's status or any timestamp. The only legal use today is the
   * dispatch correlation in `WorkflowService.launchNode` — patching
   * `data.task_id` after dispatch returns. Stays a single named
   * surface so future audit can find every place that mutates a
   * node's data outside the FSM.
   */
  patchNodeData(nodeId: string, patch: Readonly<Record<string, unknown>>): Workflow {
    const node = this.requireNode(nodeId);
    const updated = new WorkflowNodeValue(
      node.id,
      node.workflowId,
      node.type,
      node.status,
      node.spec,
      Object.freeze({ ...node.data, ...patch }),
      node.createdAt,
      node.readyAt,
      node.runningAt,
      node.endedAt,
    );
    const nodes = new Map(this._nodes);
    nodes.set(nodeId, updated);
    return this.replace({ nodes });
  }

  // ─── invariants ─────────────────────────────────────────

  /**
   * Re-validates the aggregate. Called by `fromStored` and by
   * `repository.save` so a future caller path can't smuggle a
   * corrupted state into the DB.
   */
  assertInvariants(): void {
    // 1. Every edge endpoint must be a known node.
    for (const e of this._edges) {
      if (!this._nodes.has(e.from)) {
        throw new CorruptedWorkflowError(
          this._id,
          `edge endpoint ${e.from} (from) is not a known node`,
        );
      }
      if (!this._nodes.has(e.to)) {
        throw new CorruptedWorkflowError(
          this._id,
          `edge endpoint ${e.to} (to) is not a known node`,
        );
      }
    }
    // 2. No cycles (full topo check at hydration time).
    this.assertAcyclic();
    // 3. Cross-column: outcome IS NOT NULL IFF status='archived'.
    if (this._status === "archived" && this._outcome === undefined) {
      throw new CorruptedWorkflowError(this._id, "workflow archived but outcome is undefined");
    }
    if (this._status !== "archived" && this._outcome !== undefined) {
      throw new CorruptedWorkflowError(
        this._id,
        `outcome set while status is '${this._status}' (must be 'archived')`,
      );
    }
    if (this._status === "archived" && this._archivedAt === undefined) {
      throw new CorruptedWorkflowError(this._id, "archived workflow missing archivedAt");
    }
  }

  // ─── internals ──────────────────────────────────────────

  private requireNode(nodeId: string): WorkflowNodeValue {
    const node = this._nodes.get(nodeId);
    if (node === undefined) {
      throw new CorruptedWorkflowError(this._id, `node ${nodeId} not found in workflow`);
    }
    return node;
  }

  private assertReady(node: WorkflowNodeValue): void {
    if (NODE_TERMINAL_STATUSES.has(node.status)) {
      throw new InvalidWorkflowTransitionError(node.status, "launchNode");
    }
    const ups = this.upstreamOf(node.id);
    const blocking = ups.filter((u) => {
      const n = this._nodes.get(u);
      return n === undefined || n.status !== "succeeded";
    });
    if (blocking.length > 0) {
      throw new WorkflowNodeNotReadyError(
        this._id,
        node.id,
        `upstream nodes not all succeeded: ${blocking.join(", ")}`,
      );
    }
  }

  /** DFS: does `start` reach `target` via outgoing edges? */
  private reaches(start: string, target: string): boolean {
    const stack: string[] = [start];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of this._edges) {
        if (e.from === cur) stack.push(e.to);
      }
    }
    return false;
  }

  private assertAcyclic(): void {
    // Kahn's algorithm — any non-zero residual indicates a cycle.
    const inDeg = new Map<string, number>();
    for (const id of this._nodes.keys()) inDeg.set(id, 0);
    for (const e of this._edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    const queue: string[] = [];
    for (const [id, d] of inDeg) {
      if (d === 0) queue.push(id);
    }
    let visited = 0;
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      visited++;
      for (const e of this._edges) {
        if (e.from !== cur) continue;
        const d = (inDeg.get(e.to) ?? 0) - 1;
        inDeg.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    if (visited !== this._nodes.size) {
      throw new CorruptedWorkflowError(this._id, "workflow graph contains a cycle");
    }
  }

  private everyNodeTerminal(nodes: ReadonlyMap<string, WorkflowNodeValue>): boolean {
    if (nodes.size === 0) return false;
    for (const n of nodes.values()) {
      if (!NODE_TERMINAL_STATUSES.has(n.status)) return false;
    }
    return true;
  }

  private replace(patch: {
    brief?: string;
    details?: string;
    status?: WorkflowStatus;
    outcome?: WorkflowOutcome;
    metadata?: Readonly<Record<string, unknown>>;
    startedAt?: string;
    archivedAt?: string;
    nodes?: ReadonlyMap<string, WorkflowNodeValue>;
    edges?: readonly WorkflowEdgeValue[];
  }): Workflow {
    return new Workflow(
      this._id,
      patch.brief ?? this._brief,
      patch.details ?? this._details,
      patch.status ?? this._status,
      patch.outcome ?? this._outcome,
      patch.metadata ?? this._metadata,
      this._createdAt,
      patch.startedAt ?? this._startedAt,
      patch.archivedAt ?? this._archivedAt,
      patch.nodes ?? this._nodes,
      patch.edges ?? this._edges,
    );
  }
}

function assertTaskNodeSpec(spec: TaskNodeSpec): void {
  if (spec === null || typeof spec !== "object") {
    throw new InvalidWorkflowTransitionError("workflow", "createNode", "spec must be an object");
  }
  if (typeof spec.agent !== "string" || spec.agent.length === 0) {
    throw new InvalidWorkflowTransitionError(
      "workflow",
      "createNode",
      "task spec.agent must be a non-empty string",
    );
  }
  if (typeof spec.brief !== "string" || spec.brief.length === 0) {
    throw new InvalidWorkflowTransitionError(
      "workflow",
      "createNode",
      "task spec.brief must be a non-empty string",
    );
  }
}

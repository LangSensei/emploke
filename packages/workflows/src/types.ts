/**
 * Public types for `@emploke/workflows`. Wire DTOs, option shapes,
 * and the enums callers branch on.
 *
 * Append-only-only substrate (CEO O5): every `Update*` shape here
 * either adds a new row (`createNode`, `addEdge`) or stamps a single
 * forward state transition on an existing one (`launchNode`,
 * `markDone`, `markFailed`, `cancelNode`, `finishWorkflow`).
 */

/**
 * Workflow lifecycle. Mirrors spec §4.2:
 *   `not_started → running → idle → archived`
 *
 * (`idle ↔ running` rolls only via node activity; the substrate
 * doesn't stamp a timestamp for each rollover — those live in the
 * future event-log table.)
 */
export type WorkflowStatus = "not_started" | "running" | "idle" | "archived";

/**
 * Terminal disposition stamped onto a workflow by `finishWorkflow`.
 * Adjective form (matches `@emploke/task`'s post-#119 enum); the
 * spec's older noun forms (success/failure/cancelled) were renamed
 * in the CEO O7 sync.
 */
export type WorkflowOutcome = "succeeded" | "failed" | "cancelled";

/**
 * Node lifecycle. Ratified by CEO O5:
 *
 *   not_started ─ready─► ready ─launch─► running ─done────► succeeded
 *                                                └─fail────► failed
 *   not_started ─cancel─► cancelled         (the ONLY entry to `cancelled`)
 *
 * `not_started → ready` is automatic — auto-promoted by `markDone`
 * once every upstream dep is `succeeded`. Every other transition is
 * orchestrator-driven and strictly forward.
 */
export type WorkflowNodeStatus =
  | "not_started"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** v1 locks node type to `'task'`; future arms (human, decision) deferred. */
export type WorkflowNodeType = "task";

/** Wire DTO for a workflow row. */
export interface Workflow {
  readonly id: string;
  readonly brief: string;
  readonly details?: string;
  readonly status: WorkflowStatus;
  readonly outcome?: WorkflowOutcome;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly archivedAt?: string;
}

/** Wire DTO for a workflow node row. */
export interface WorkflowNode {
  readonly id: string;
  readonly workflowId: string;
  readonly type: WorkflowNodeType;
  readonly status: WorkflowNodeStatus;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly readyAt?: string;
  readonly runningAt?: string;
  readonly endedAt?: string;
}

/** Wire DTO for a single DAG edge. */
export interface WorkflowEdge {
  readonly workflowId: string;
  readonly from: string;
  readonly to: string;
}

/** Result of `WorkflowsService.getState` — workflow + all nodes + all edges. */
export interface WorkflowState {
  readonly workflow: Workflow;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

/** Args accepted by `createWorkflow`. */
export interface CreateWorkflowArgs {
  readonly brief: string;
  readonly details?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Override the id (deterministic-test seam). */
  readonly id?: string;
}

/** `type='task'` `spec` shape per spec §4.3. */
export interface TaskNodeSpec {
  readonly agent: string;
  readonly brief: string;
  readonly details?: string;
  readonly runtime?: string;
}

/** Args accepted by `createNode`. v1: only `type='task'` is legal. */
export interface CreateNodeArgs {
  readonly type: WorkflowNodeType;
  readonly spec: TaskNodeSpec;
  /** Override the node id (deterministic-test seam). */
  readonly id?: string;
}

/**
 * Result of `markDone` — the node's data is patched into the node's
 * `data` JSON column. Per CEO O5 the substrate doesn't dictate the
 * shape; for `type='task'` it'll typically be the task's terminal
 * payload (success / failure mirror).
 */
export type NodeResultPatch = Readonly<Record<string, unknown>>;

/**
 * Surface a {@link TaskService} subset that this package needs to
 * dispatch the task that backs a `type='task'` node. The whole
 * `TaskService` interface is larger; we only depend on `dispatch`
 * here so tests can stub it without spinning up a full task module.
 */
export interface TaskDispatcher {
  dispatch(opts: {
    readonly agent: string;
    readonly brief: string;
    readonly details?: string;
    readonly runtime?: string;
    readonly origin?: "standalone" | "workflow";
  }): Promise<{ readonly id: string } & Record<string, unknown>>;
}

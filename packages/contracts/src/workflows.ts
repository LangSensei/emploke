/**
 * Wire-shape DTOs for the workflows HTTP / dispatch surface.
 *
 * The workflow substrate (`@emploke/workflow`) stores nodes as an
 * opaque `{ kind: string, spec: unknown }` envelope and is
 * deliberately kind-agnostic. The per-kind wire DTOs live here, in
 * the cross-cutting `@emploke/contracts` package, so the substrate
 * stays free of kind knowledge and so the same shapes can be
 * imported by the SPA, the CLI, and the server without dragging in
 * `@emploke/workflow`'s implementation modules.
 */

/**
 * Task-kind node spec payload. Flat, matches the body shape minus
 * the discriminator. Persisted opaquely as `workflow_nodes.spec_json`
 * via the substrate's envelope; consumed flatly on the wire.
 *
 * The task-kind handler enforces (at insert time):
 *
 *   1. `agent` non-empty string AND exists in the catalog AND appears
 *      in the caller coord agent's `dependencies.agents` declaration.
 *      The last clause means a coordinator can only dispatch task
 *      nodes for agents it has statically declared a dependency on,
 *      so the static dependency graph is also the runtime
 *      dispatch-permission graph.
 *   2. `brief` non-empty string, no `\n`/`\r`, length ≤ 200 (matches
 *      `@emploke/task` `DispatchOpts.brief`).
 *   3. `details` when present, must be string (empty allowed).
 *   4. `runtime` when present, must be non-empty string.
 */
export interface WorkflowTaskNodeSpec {
  /**
   * Worker agent FQN. MUST appear in the most-recent coord node's
   * `spec.agent`'s `dependencies.agents` (validated by the
   * task-kind handler at insert time).
   */
  readonly agent: string;
  /** Worker brief: single line, ≤ 200 chars (no `\n` / `\r`). */
  readonly brief: string;
  /** Optional multi-line context for the worker. */
  readonly details?: string;
  /** Optional runtime override (e.g. `bash`, `python`). Non-empty when present. */
  readonly runtime?: string;
}

/**
 * Coordinator-kind node spec payload. Every coordinator node carries
 * its own agent FQN — the workflow's `coordinator_agent` header
 * column is just a denorm cache of the most-recently-created coord
 * node's `spec.agent`.
 *
 * The silent-retry path (the substrate's auto-respawn when a coord
 * exits without making forward progress) copies the predecessor's
 * `spec_json` verbatim, so a retry is byte-identical to its
 * predecessor. When a coord schedules a new successor explicitly,
 * the coord chooses what agent to use — inheriting the same agent
 * is convention, not enforced.
 *
 * The coordinator-kind handler enforces (at insert time):
 *
 *   1. `agent` non-empty string AND exists in catalog AND its
 *      `dependencies.skills` MUST include `emploke/coordinator`.
 */
export interface WorkflowCoordinatorNodeSpec {
  /** Coordinator agent FQN. */
  readonly agent: string;
}

/**
 * Flat wire projection for a task-kind workflow node spec. The
 * internal envelope `{ kind: "task", spec: { agent, brief, ... } }`
 * is flattened to `{ kind: "task", agent, brief, ... }` for HTTP
 * responses so dashboard / CLI code can read `node.spec.agent`
 * without unwrapping `spec`.
 */
export type WorkflowTaskNodeSpecWire = { readonly kind: "task" } & WorkflowTaskNodeSpec;

/** Flat wire projection for a coordinator-kind workflow node spec. */
export type WorkflowCoordinatorNodeSpecWire = {
  readonly kind: "coordinator";
} & WorkflowCoordinatorNodeSpec;

/**
 * Wire-shape spec on workflow node responses. Flat for the two
 * shipped kinds (`task` / `coordinator`); opaque envelope for any
 * future kind the server projects through unchanged. When a third
 * concrete kind ships, add its flat wire shape here as another
 * union member.
 */
export type WorkflowNodeWireSpec =
  | WorkflowTaskNodeSpecWire
  | WorkflowCoordinatorNodeSpecWire
  | { readonly kind: string; readonly spec: unknown };

// ─── HTTP wire-shape DTOs ─────────────────────────────────────────

/**
 * Workflow lifecycle status, mirrored from `@emploke/workflow`'s
 * `WorkflowStatus`. Duplicated as a literal-union string here so the
 * contracts package stays free of a runtime dep on `@emploke/workflow`.
 */
export type WorkflowStatusWire = "running" | "succeeded" | "failed" | "cancelled";

/**
 * Workflow node lifecycle status, mirrored from `@emploke/workflow`'s
 * `WorkflowNodeStatus`. Duplicated as a literal-union string here so
 * the contracts package stays free of a runtime dep on
 * `@emploke/workflow`.
 */
export type WorkflowNodeStatusWire =
  | "not_started"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * Wire projection of a workflow header. Field set mirrors the
 * persisted `WorkflowEntity` shape verbatim — timestamps are ISO 8601
 * strings (already stored that way), optional `endedAt` is absent on
 * non-terminal rows. `iterationCount` is computed by the server from
 * the workflow's coord-node count (silent-retry coords are counted
 * too — a retry IS another iteration from the user's perspective);
 * see `deriveIterationCount` in `@emploke/workflow`.
 */
export interface WorkflowHeaderWire {
  readonly id: string;
  readonly brief: string;
  readonly details?: string;
  readonly coordinatorAgent: string;
  readonly status: WorkflowStatusWire;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly iterationCount: number;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

/**
 * Wire projection of a single workflow node. Per-kind `spec` is
 * projected flat via {@link WorkflowNodeWireSpec}. Lifecycle
 * timestamps mirror the persisted `WorkflowNodeEntity` shape —
 * `readyAt` / `runningAt` / `endedAt` are present once the node has
 * reached that state.
 */
export interface WorkflowNodeWire {
  readonly id: string;
  readonly workflowId: string;
  readonly phase: number;
  readonly status: WorkflowNodeStatusWire;
  readonly spec: WorkflowNodeWireSpec;
  readonly createdAt: string;
  readonly readyAt?: string;
  readonly runningAt?: string;
  readonly endedAt?: string;
}

/** Wire projection of one DAG edge — parent / child node ids only. */
export interface WorkflowEdgeWire {
  readonly from: string;
  readonly to: string;
}

/**
 * Wire projection of the full DAG snapshot returned by
 * `GET /workspaces/:id/workflows/:wfid/dag`. The header is denormed
 * onto the snapshot for client convenience (so a single fetch yields
 * everything the dashboard needs to render the graph).
 */
export interface WorkflowDagWire {
  readonly workflow: WorkflowHeaderWire;
  readonly nodes: readonly WorkflowNodeWire[];
  readonly edges: readonly WorkflowEdgeWire[];
}

/**
 * Request body for `POST /workspaces/:id/workflows`. Mirrors
 * `WorkflowService.createWorkflow` args. `metadata` is opaque and
 * forwarded verbatim to the substrate.
 */
export interface CreateWorkflowBody {
  readonly brief: string;
  readonly details?: string;
  readonly coordinatorAgent: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Query string for `GET /workspaces/:id/workflows`. When `status` is
 * supplied, the server narrows the list to that lifecycle status;
 * otherwise every workflow is returned. Unknown `status` values are
 * rejected at the route boundary with HTTP 400.
 */
export interface WorkflowListQuery {
  readonly status?: WorkflowStatusWire;
}

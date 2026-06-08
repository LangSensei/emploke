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
  /**
   * Dispatched task id for this node. Present iff this node has a
   * dispatched task — both worker AND coordinator nodes get a
   * `taskId` because the substrate dispatches coord agents as tasks
   * too (see `packages/api/src/wiring/workflow-coord-task-runner.ts`).
   * Absent on a node that has been inserted but not yet dispatched
   * (a tight window in normal operation). Server-enriched at
   * projection time via the `task.metadata.workflowNodeId === node.id`
   * reverse-lookup; see `projectWorkflowNodeWithTaskId` in
   * `packages/server/src/routes/_workflow-projection.ts`.
   */
  readonly taskId?: string;
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

// ─── Mutation primitives — wire-shape DTOs ────────────────────────
//
// One body shape per substrate mutation primitive. Each mirrors the
// corresponding `WorkflowService.<method>(args)` shape 1:1, with one
// boundary translation: `workflowId` lives in the URL path, not the
// body. Wire shapes are JSON-safe — plain literal-union strings (no
// `Date`, `Map`, `Set`, `Symbol`).
//
// Auth is substrate-derived: the unique `kind='coordinator' AND
// status='running'` row in the workflow IS the caller. HTTP routes
// forward `workflowId` from the path; they do NOT accept a
// `callerCoordNodeId` body field, header, or query param. A request
// from outside any coord task gets `WorkflowMutationUnauthorizedError`
// → 403.

/**
 * Per-node kind discriminator on every mutation body that allocates a
 * new node. Mirrors `NodeKind` in `@emploke/workflow`. Listed as a
 * literal-union string here so this pkg has no runtime dep on the
 * substrate.
 */
export type WorkflowNodeKindWire = "coordinator" | "worker";

/**
 * Request body for `POST /workspaces/:id/workflows/:wfid/nodes`.
 * Mirrors `WorkflowService.addNode` args minus `workflowId` (in path).
 *
 * `spec` is forwarded verbatim to the substrate — the per-kind runner
 * is the validator. `parents` MUST have ≥1 entry; an empty array is
 * rejected by the substrate with `EmptyParentsError` → 400.
 */
export interface AddNodeBody {
  readonly kind: WorkflowNodeKindWire;
  readonly spec: unknown;
  readonly parents: readonly string[];
}

/**
 * Response of `POST /workspaces/:id/workflows/:wfid/nodes`. Mirrors
 * `AddNodeResult` from the substrate.
 */
export interface AddNodeResultWire {
  readonly nodeId: string;
  readonly phase: number;
}

/**
 * Request body for `POST /workspaces/:id/workflows/:wfid/edges`.
 * Mirrors `WorkflowService.addEdge` args minus `workflowId`.
 */
export interface AddEdgeBody {
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

/**
 * Response of `POST /workspaces/:id/workflows/:wfid/edges`. Echoes the
 * pair back so the caller has a self-contained record of the inserted
 * edge without re-fetching the DAG.
 */
export interface AddEdgeResultWire {
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

/**
 * Wire-shape projection of the substrate's `NodeRef` discriminated
 * union. The substrate spells it `{ kind: "existing", id }` /
 * `{ kind: "temp", tempId }`; on the wire we drop the explicit
 * discriminator and rely on the presence of `nodeId` vs `tempId` —
 * each arm has exactly one own field, so the union is unambiguous in
 * JSON. The route boundary translates one shape to the other before
 * calling the substrate.
 */
export type NodeRefWire = { readonly nodeId: string } | { readonly tempId: string };

/**
 * One declared temp node in an `addSubgraph` batch. Mirrors
 * `AddSubgraphNodeInput` from the substrate. `existingParents` is
 * optional and defaults to `[]` (the substrate normalizes); intra-
 * batch parent edges go in {@link AddSubgraphBody.edges}.
 */
export interface AddSubgraphNodeInputWire {
  readonly tempId: string;
  readonly kind: WorkflowNodeKindWire;
  readonly spec: unknown;
  readonly existingParents?: readonly string[];
}

/** One declared edge in an `addSubgraph` batch. */
export interface AddSubgraphEdgeInputWire {
  readonly from: NodeRefWire;
  readonly to: NodeRefWire;
}

/**
 * Request body for `POST /workspaces/:id/workflows/:wfid/subgraph`.
 * Mirrors `WorkflowService.addSubgraph` args minus `workflowId`.
 *
 * `nodes.length ≥ 1` is required; the substrate rejects an empty
 * batch with `WorkflowSubgraphEmptyError` → 400.
 */
export interface AddSubgraphBody {
  readonly nodes: readonly AddSubgraphNodeInputWire[];
  readonly edges: readonly AddSubgraphEdgeInputWire[];
}

/**
 * Per-inserted-node entry on `AddSubgraphResultWire`. Echoes the
 * caller-supplied `tempId` alongside the substrate-allocated `nodeId`
 * + computed `phase` so the caller can map results back to its batch.
 */
export interface AddSubgraphInsertedNodeWire {
  readonly tempId: string;
  readonly nodeId: string;
  readonly phase: number;
}

/** Response of `POST /workspaces/:id/workflows/:wfid/subgraph`. */
export interface AddSubgraphResultWire {
  readonly insertedNodes: readonly AddSubgraphInsertedNodeWire[];
}

/**
 * Request body for `PATCH /workspaces/:id/workflows/:wfid/nodes/:nid/spec`.
 * `newSpec` is forwarded verbatim — the per-kind runner re-validates
 * with the same rules used at insert time.
 */
export interface ReplaceNodeSpecBody {
  readonly newSpec: unknown;
}

/**
 * Request body for `POST /workspaces/:id/workflows/:wfid/finish`.
 * `outcome` MUST be `"succeeded"` or `"failed"`; the substrate
 * rejects any other value at the boundary (`WorkflowError` → 400).
 * Workflow-level cancellation is a separate route
 * (`POST .../cancel`).
 */
export interface FinishWorkflowBody {
  readonly outcome: "succeeded" | "failed";
}

/**
 * MIME bucket for a workflow artifact. Hint used by the dashboard's
 * Artifacts tab to pick an icon (📄 text / 🖼️ image / 📦 archive /
 * 📎 generic) without doing its own ext sniffing. Server-side
 * detection lives in `packages/server/src/util/mime-bucket.ts`.
 */
export type WorkflowArtifactMimeBucket = "text" | "image" | "archive" | "generic";

/**
 * Wire projection of a single workflow artifact. Discriminated by
 * `kind`:
 *
 *   - `workflow-summary` — file under `<workflowDir>/artifact/`,
 *     curated by the coordinator. `path` is relative to that root.
 *     Coordinator may rewrite at any time (the static-bytes route
 *     sends `Cache-Control: no-store` for this kind).
 *   - `node` — file under `<tasks-root>/<taskId>/artifact/`, owned
 *     by a single worker / coord node. Write-once after the task
 *     terminates (the static-bytes route sends `Cache-Control:
 *     max-age=300` for this kind).
 *
 * `mimeBucket` is the server's presentation hint — see
 * {@link WorkflowArtifactMimeBucket}.
 */
export type WorkflowArtifactWire =
  | {
      readonly kind: "workflow-summary";
      /** Relative path under `<workflowDir>/artifact/`. */
      readonly path: string;
      /** Size in bytes. */
      readonly size: number;
      /** RFC3339 mtime. */
      readonly modifiedAt: string;
      /** Detected MIME bucket: "text" | "image" | "archive" | "generic". */
      readonly mimeBucket: WorkflowArtifactMimeBucket;
    }
  | {
      readonly kind: "node";
      /** The owning node id. */
      readonly nodeId: string;
      /** The owning node's task id (from substrate enrichment). */
      readonly taskId: string;
      /** Relative path under `<tasks-root>/<taskId>/artifact/`. */
      readonly path: string;
      readonly size: number;
      readonly modifiedAt: string;
      readonly mimeBucket: WorkflowArtifactMimeBucket;
    };

/**
 * Wire response shape for `GET /workspaces/:id/workflows/:wfid/artifacts`.
 *
 * Artifacts are listed in two namespaces: `workflow-summary`
 * artifacts live under `<workflowDir>/artifact/` (curated by the
 * coordinator); `node` artifacts live under each worker / coord
 * task's `artifact/` dir. The list route aggregates both,
 * `workflow-summary` first then `node` groups sorted by `nodeId` for
 * stability.
 */
export interface WorkflowArtifactsResponse {
  readonly artifacts: readonly WorkflowArtifactWire[];
}

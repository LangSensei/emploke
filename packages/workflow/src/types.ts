/**
 * Public types for `@emploke/workflow`.
 *
 * The workflow pkg is an open substrate: it stores `workflow_nodes`
 * rows with an opaque `{ kind: string, spec: unknown }` envelope and
 * routes every kind-aware operation (validate, dispatch, in-flight
 * check, cancel) through a {@link WorkflowNodeKindHandler} the caller
 * registers at compose time. The pkg has no built-in knowledge of
 * `'task'`, `'coordinator'`, or any other concrete kind — adding one
 * requires zero edits to `packages/workflow/src/`.
 *
 * Per-kind wire DTOs (`WorkflowTaskNodeSpec`,
 * `WorkflowCoordinatorNodeSpec`, `WorkflowNodeWireSpec`, …) live in
 * `@emploke/contracts/workflows` and are re-exported below so
 * external callers don't need to know which package owns the wire
 * shapes.
 */

// ─── Re-exports from @emploke/contracts ─────────────────────────────
//
// Workflow node spec wire types live in `@emploke/contracts` because
// they cross the HTTP wire and are consumed by the SPA / CLI. The
// workflow substrate re-exports them so consumers can `import { ... }
// from "@emploke/workflow"` without learning that DTOs come from a
// sibling package.
export type {
  WorkflowCoordinatorNodeSpec,
  WorkflowCoordinatorNodeSpecWire,
  WorkflowNodeWireSpec,
  WorkflowTaskNodeSpec,
  WorkflowTaskNodeSpecWire,
} from "@emploke/contracts";

// ─── FSM enums ──────────────────────────────────────────────────────

/**
 * Workflow-level FSM. Four values, exactly one non-terminal
 * (`running`). The substrate deliberately does NOT persist a separate
 * "actively coordinating right now" status — that's derived from
 * `workflow_nodes` (any `coordinator`-kind node with `status =
 * 'running'`); see {@link hasLiveCoord}.
 *
 * Forward-only: once a workflow hits a terminal status, no further
 * status mutation is allowed.
 */
export type WorkflowStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * Per-node FSM. Same vocabulary applies to BOTH task-kind and
 * coordinator-kind nodes.
 *
 *   not_started ─ready─► ready ─launch─► running ─done────► succeeded
 *                                                └─fail────► failed
 *
 * `cancelled` is the cancel terminal, legal from `not_started`,
 * `ready`, or `running` for task-kind only. Coordinator-kind nodes
 * are never cancelled directly — workflow-level cancellation goes
 * through `cancelWorkflow`, which cascades.
 */
export type WorkflowNodeStatus =
  | "not_started"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

// ─── Derived-view helpers (NOT persisted) ───────────────────────────

/**
 * "Is there a coordinator actively running right now?" Pure derived
 * predicate over the node set — there is intentionally no workflow-
 * column equivalent, because making this stateful would mean every
 * coord wake/sleep had to update two rows transactionally and the
 * substrate would silently drift if the second write failed.
 *
 * Pure function; safe to call from anywhere (SPA, CLI, server).
 */
export function hasLiveCoord(
  nodes: ReadonlyArray<{
    readonly kind: string;
    readonly status: WorkflowNodeStatus;
  }>,
): boolean {
  return nodes.some((n) => n.kind === "coordinator" && n.status === "running");
}

/**
 * Iteration count — the number of coordinator-kind nodes ever
 * created in this workflow. UI / CLI use it to render "Iteration N"
 * labels. Silent-retry coord nodes (the substrate's automatic
 * respawn when a coord exits without making forward progress) ARE
 * counted: from the user's perspective, a retry IS another
 * iteration.
 *
 * Pure function over a pre-computed count; the workflow pkg's
 * service layer provides a one-shot SQL to get the count.
 */
export function deriveIterationCount(coordNodeCount: number): number {
  return coordNodeCount;
}

// ─── Kind-handler substrate interface ───────────────────────────────

/**
 * Opaque envelope persisted by the workflow pkg for every node. The
 * `spec` payload is `unknown` because the substrate deliberately
 * doesn't know per-kind shape; the registered
 * {@link WorkflowNodeKindHandler} owns parsing / validation /
 * dispatch / in-flight check / cancel.
 *
 * On disk: `kind` lives in `workflow_nodes.kind` and `spec` is
 * `JSON.stringify`ed into `workflow_nodes.spec_json`. The kind is
 * NOT redundantly nested inside `spec_json`.
 */
export interface WorkflowNodeSpecEnvelope {
  readonly kind: string;
  readonly spec: unknown;
}

/**
 * Context threaded into `WorkflowNodeKindHandler.validate`. Carries
 * caller-coord identity so per-kind validators can enforce
 * cross-coord rules — most notably the task-kind rule that a node's
 * `agent` FQN must appear in the caller coord agent's
 * `dependencies.agents` declaration. Without this context the
 * substrate would either have to know about catalog dependencies
 * (breaking layering) or skip the check (losing the static guarantee
 * that a coord can only dispatch agents it's declared a dependency
 * on).
 *
 * Bootstrap cases (the initial coord insert by `createWorkflow`, and
 * the silent-retry coord insert) populate ctx with the just-inserted
 * coord's identity (callerCoordNodeId = self id; callerCoordSpec =
 * self spec). This keeps the validate API uniform: there is always a
 * caller, even when the caller IS the node being validated.
 */
export interface WorkflowNodeValidateCtx {
  readonly workflowId: string;
  /**
   * The coord node calling the mutation primitive — i.e. the parent
   * in the auth/causality sense. For the initial coord insert and
   * the silent-retry insert, this is the just-inserted node's own
   * id (self).
   */
  readonly callerCoordNodeId: string;
  /**
   * The caller coord's persisted spec. The task-kind handler reads
   * `callerCoordSpec.agent` to enforce that the worker's FQN appears
   * in the coord agent's `dependencies.agents`.
   */
  readonly callerCoordSpec: { readonly agent: string };
  /**
   * Useful for cross-workflow-state checks; rarely needed. Always
   * `'running'` when called from a mutation primitive (the
   * mutation-auth gate rejects mutations on terminal workflows).
   */
  readonly workflowStatus: WorkflowStatus;
}

/**
 * Per-kind handler registered at compose time via
 * `WorkflowService.registerKind(kind, handler)`. Implementations
 * live wherever the kind is integrated — both shipping handlers
 * (`'task'` and `'coordinator'`) live in `packages/api/src/wiring/`
 * because they know about `@emploke/workflow`, `@emploke/task`, AND
 * `@emploke/catalog`. The substrate pkg itself never imports any of
 * its callers.
 *
 * No capabilities flag on the interface: coord-special behaviors
 * (the mutation auth gate, silent-retry detection, the
 * `workflows.coordinator_agent` denorm sync) are encoded in the
 * engine itself, not routed through a polymorphic interface method.
 * That keeps the handler interface intentionally minimal — validate
 * / dispatch / hasInFlightForNode / cancel — and means a new kind
 * only has to answer those four questions.
 */
export interface WorkflowNodeKindHandler {
  /**
   * Validate an inbound `spec` payload. MUST throw on invalid shape;
   * MAY perform async side-effects (e.g. catalog existence lookup
   * for an agent FQN). Returns the validated / normalized payload,
   * which the substrate persists as `spec_json`. Implementations are
   * free to normalize (trim, drop unknown keys); the returned value
   * is what gets stored.
   */
  validate(spec: unknown, ctx: WorkflowNodeValidateCtx): Promise<unknown>;

  /**
   * Fire the unit of work backing this node. Called by the substrate
   * when the node transitions `not_started|ready → running`. The
   * handler dispatches whatever it needs (e.g. a task) and stamps
   * `{ workflowId, workflowNodeId }` into the unit's metadata so the
   * reverse-lookup partial indexes engage.
   *
   * Returns a substrate-side identifier (e.g. task id) for audit;
   * the substrate does NOT persist this id — reverse lookup goes
   * through the unit's metadata, not through a `workflow_nodes`
   * column. (Persisting it would create a denorm the substrate would
   * have to keep in sync with the unit-of-work side.)
   */
  dispatch(opts: {
    readonly workflowId: string;
    readonly nodeId: string;
    readonly spec: unknown;
    readonly nodeDir: string;
  }): Promise<{ readonly unitId: string }>;

  /**
   * Whether this kind currently has a dispatched-but-incomplete
   * unit-of-work for `nodeId`. Used by cancel reconciliation AND by
   * engine-restart recovery (`running` rows with no in-flight unit
   * get rolled back to `ready`).
   */
  hasInFlightForNode(nodeId: string): Promise<boolean>;

  /**
   * Cancel the in-flight unit-of-work for `nodeId`. Idempotent;
   * best-effort. Cancellation semantically means "the substrate will
   * ignore the unit's eventual outcome", NOT proof that the unit has
   * actually stopped — the unit may still complete after the cancel
   * returns, and its result will simply be discarded.
   */
  cancel(nodeId: string): Promise<void>;
}

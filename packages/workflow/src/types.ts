/**
 * Public types for `@emploke/workflow`.
 *
 * The workflow pkg is a substrate over a closed kind enum: it stores
 * `workflow_nodes` rows with a `{ kind: NodeKind, spec: unknown }`
 * envelope and routes every kind-aware operation (validate, dispatch,
 * in-flight check, cancel) through a {@link WorkflowNodeRunner}
 * injected at compose time. The substrate has compile-time knowledge
 * of the kind set (`'coordinator' | 'worker'`) and of kind-aware
 * semantic rules, but does NOT know HOW each kind dispatches or what
 * spec shape each kind requires — those are runner concerns.
 *
 * Per-kind wire DTOs (`WorkflowWorkerNodeSpec`,
 * `WorkflowCoordinatorNodeSpec`, `WorkflowNodeWireSpec`, …) live in
 * `@emploke/contracts`; this file owns only substrate-side types
 * (`NodeKind`, `WorkflowStatus`, `WorkflowNodeStatus`,
 * `WorkflowNodeSpecEnvelope`, `WorkflowNodeValidateCtx`,
 * `WorkflowNodeRunner`, `WorkflowRunners`, and the two derived-view
 * helpers `hasLiveCoord` / `deriveIterationCount`).
 */

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

// ─── Terminal payloads ──────────────────────────────────────────────

/**
 * Payload attached when a workflow transitions to `succeeded`. Set
 * by the coord's `finishWorkflow({outcome:'succeeded', success})`
 * call. `output` is the coord's free-text summary of the run — what
 * gets rendered as the "Summary" card on the dashboard Overview
 * tab. Coord MAY pass `null` (or omit `output` entirely → defaults
 * to null) when the workflow has no meaningful summary to show.
 *
 * No `artifacts` field — workflow artifacts live durably under
 * `<workflowDir>/artifact/` and are discovered via the
 * `/artifacts` listing route. There's no workdir-cleanup concern
 * the task analog protects against.
 */
export interface WorkflowSuccess {
  readonly output: string | null;
}

/**
 * Payload attached when a workflow transitions to `failed`. Set by
 * the coord's `finishWorkflow({outcome:'failed', failure})` call.
 *
 * `kind` is a closed-set discriminator forward-compatible with
 * future substrate-detected failure modes:
 *
 *   - `coord`    — coord explicitly called failWorkflow. v2.2 ships
 *                  this kind only.
 *   - `internal` — reserved for future substrate-detected failures
 *                  (e.g. workflow-engine-restart reconciliation
 *                  finding an unrecoverable state). Not produced by
 *                  v2.2 but accepted on the read path so older /
 *                  newer schema rows round-trip.
 *
 * `message` is the human-readable summary the dashboard renders.
 */
export type WorkflowFailure =
  | { readonly kind: "coord"; readonly message: string }
  | { readonly kind: "internal"; readonly message: string };

/**
 * Payload attached when a workflow transitions to `cancelled`. Set
 * by the cancelWorkflow route.
 *
 *   - `user`    — operator called cancelWorkflow via dashboard / CLI.
 *                  v2.2 ships this kind only.
 *   - `cascade` — reserved for future parent-workflow cancellation.
 *                  Not produced by v2.2 but accepted on the read
 *                  path for forward compat.
 */
export type WorkflowCancellation =
  | { readonly kind: "user"; readonly message: string }
  | { readonly kind: "cascade"; readonly message: string };

/**
 * Per-node FSM. Same vocabulary applies to BOTH worker-kind and
 * coordinator-kind nodes.
 *
 *   not_started ─ready─► ready ─launch─► running ─done────► succeeded
 *                                                └─fail────► failed
 *
 * `cancelled` is the cancel terminal, legal from `not_started`,
 * `ready`, or `running` for worker-kind only. Coordinator-kind nodes
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

// ─── Closed kind enum ───────────────────────────────────────────────

/**
 * Closed enum of substrate-supported node roles. `'coordinator'` is
 * the conductor that mutates the DAG; `'worker'` is a unit of work
 * dispatched by a coordinator. The set is fixed at compile time —
 * adding a new role (e.g. `'human'` for approval gates) requires
 * extending this literal union AND adding a matching field on
 * {@link WorkflowRunners}; TypeScript catches any unhandled case as
 * a compile error.
 *
 * The string values `"coordinator"` / `"worker"` are also the
 * persisted `workflow_nodes.kind` column values; the substrate's
 * defensive {@link WorkflowNodeKindUnknownError} only fires when a
 * persisted row carries a value outside this union (schema
 * corruption / older-binary leftover row).
 */
export type NodeKind = "coordinator" | "worker";

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

// ─── Runner substrate interface ─────────────────────────────────────

/**
 * Opaque envelope persisted by the workflow pkg for every node. The
 * `spec` payload is `unknown` because the substrate deliberately
 * doesn't know per-kind shape; the injected per-kind
 * {@link WorkflowNodeRunner} owns parsing / validation / dispatch /
 * in-flight check / cancel.
 *
 * On disk: `kind` lives in `workflow_nodes.kind` and `spec` is
 * `JSON.stringify`ed into `workflow_nodes.spec_json`. The kind is
 * NOT redundantly nested inside `spec_json`.
 */
export interface WorkflowNodeSpecEnvelope {
  readonly kind: NodeKind;
  readonly spec: unknown;
}

/**
 * Context threaded into `WorkflowNodeRunner.validate`. Carries the
 * workflow id and the workflow's current status so per-kind runners
 * can do cross-workflow-state checks if needed; the substrate stays
 * kind-agnostic and does NOT pass any caller identity. Runners that
 * need to check catalog references on `spec` do so against the
 * catalog directly.
 *
 * For ordinary mutation paths the substrate calls `validate` with
 * `workflowStatus: 'running'` (mutations are only legal on running
 * workflows). The bootstrap path inside `createWorkflow` also passes
 * `'running'` because the new workflow is constructed in that state.
 */
export interface WorkflowNodeValidateCtx {
  readonly workflowId: string;
  /**
   * Workflow status at the time `validate` is called. Always
   * `'running'` for ordinary mutations — the substrate refuses
   * mutations on terminal workflows before `validate` runs.
   */
  readonly workflowStatus: WorkflowStatus;
}

/**
 * Outcome reported by a runner once the unit-of-work backing a
 * dispatched node has reached a terminal state. The runner observes
 * the outcome (e.g. by polling its task store, or by being driven by
 * an in-process event) and calls the `onTerminal` callback supplied
 * to {@link WorkflowNodeRunner.dispatch}, which lets the engine mark
 * the substrate's node terminal and re-evaluate downstream readiness.
 *
 * The discriminated union is intentionally narrow: the substrate only
 * cares about *which terminal state* the node should land in, plus a
 * human-readable `reason` for the `failed` arm. `output` is a
 * runner-supplied opaque blob (e.g. exit code, runtime metadata)
 * that the substrate currently logs at debug — it does NOT
 * denormalize it into the `workflow_nodes` row, because that would
 * couple the substrate to per-runner payload shapes. (Result data
 * proper lives on the unit-of-work side, e.g. `tasks.result_json`.)
 */
export type WorkflowNodeTerminalResult =
  | { readonly status: "succeeded"; readonly output?: unknown }
  | { readonly status: "failed"; readonly reason: string; readonly output?: unknown }
  | { readonly status: "cancelled" };

/**
 * Per-kind runner injected at compose time via the `runners`
 * parameter to `composeWorkflowModule`. The substrate has built-in
 * knowledge of the closed kind enum (`'coordinator' | 'worker'`) and
 * of kind-aware semantic rules (e.g. per-kind parent-readiness, the
 * single-coord-successor rule, the orphan-coord rule, the
 * `workflows.coordinator_agent` denorm sync), but does NOT know HOW
 * each kind dispatches or what spec shape each kind requires — both
 * are runner concerns.
 *
 * No capabilities flag on the interface: coord-special behaviors
 * (the mutation auth gate, silent-retry detection, the
 * `workflows.coordinator_agent` denorm sync) are encoded in the
 * engine itself, not routed through a polymorphic interface method.
 * That keeps the runner interface intentionally minimal — validate
 * / dispatch / hasInFlightForNode / cancel — and means a new kind
 * only has to answer those four questions.
 *
 * Concrete runners live wherever they bridge the substrate to its
 * mechanism (e.g. `packages/api/src/wiring/` for the shipping
 * coordinator/worker runners that adapt `@emploke/task` +
 * `@emploke/catalog` to this interface). The substrate pkg itself
 * never imports any of its callers.
 */
export interface WorkflowNodeRunner {
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
   * runner dispatches whatever it needs (e.g. a task) and stamps
   * `{ workflowId, workflowNodeId }` into the unit's metadata so the
   * reverse-lookup partial indexes engage.
   *
   * The runner MUST invoke `opts.onTerminal` exactly once per dispatch
   * when (and only when) it has observed a terminal outcome
   * (`succeeded` / `failed` / `cancelled`) for the unit of work
   * backing this dispatch call. The engine threads this callback
   * through so the substrate can mark the node terminal and
   * re-evaluate downstream readiness without the runner having to
   * know about service plumbing. `onTerminal` is idempotent on the
   * service side — re-invoking it is a no-op once the node is
   * terminal — but runners SHOULD avoid double-calling because it
   * costs a redundant tx.
   *
   * `onTerminal` MAY be invoked synchronously inside `dispatch`
   * (zero-latency runners) or asynchronously after `dispatch` has
   * already returned. The engine commits the `ready → running`
   * transition BEFORE calling `dispatch`, so the substrate's row is
   * always in the right state when `onTerminal` fires.
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
    readonly onTerminal: (result: WorkflowNodeTerminalResult) => void;
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

/**
 * Compose-time wiring: one runner per substrate kind. Required by
 * `composeWorkflowModule`; both fields are non-optional so a missing
 * runner is a TypeScript compile error rather than a runtime throw.
 *
 * Adding a new kind to {@link NodeKind} forces a matching field to
 * appear here — TypeScript's exhaustiveness propagates to every
 * `switch (kind)` over `NodeKind` in the substrate, so missing the
 * new runner cannot ship.
 */
export interface WorkflowRunners {
  readonly coordinator: WorkflowNodeRunner;
  readonly worker: WorkflowNodeRunner;
}

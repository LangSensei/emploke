import { randomUUID as nodeRandomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import {
  COORDINATOR_KIND,
  computePhaseFromParents,
  nodeEntityFor,
  parentsOf,
  parentsReadyForKind,
  parseSpecJson,
  WORKER_KIND,
  workflowEntityFor,
  wouldCreateCycle,
} from "./_dag.js";
import { assertCoordinatorSpecAgent } from "./_helpers.js";
import {
  EmptyParentsError,
  MultipleSuccessorCoordsError,
  OrphanCoordInsertError,
  ParentStateError,
  WorkflowAlreadyTerminalError,
  WorkflowEdgeCycleError,
  WorkflowError,
  WorkflowMutationUnauthorizedError,
  WorkflowNodeKindUnknownError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
  WorkflowNotFoundError,
} from "./errors.js";
import { workflowNodeDir } from "./paths.js";
import type * as schema from "./schema.js";
import { workflows } from "./schema.js";
import type {
  NodeKind,
  WorkflowNodeRunner,
  WorkflowNodeStatus,
  WorkflowNodeValidateCtx,
  WorkflowRunners,
} from "./types.js";
import { generateWorkflowId, generateWorkflowNodeId } from "./validate.js";
import type { WorkflowEdgeEntity, WorkflowEntity, WorkflowNodeEntity } from "./workflow-entity.js";
import type { WorkflowRepository } from "./workflow-repository.js";

type Db = BetterSQLite3Database<typeof schema>;

const silentLogger: Logger = pino({ level: "silent" });

export interface WorkflowServiceOpts {
  readonly repo: WorkflowRepository;
  readonly db: Db;
  readonly workspaceDir: string;
  readonly runners: WorkflowRunners;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

export interface CreateWorkflowArgs {
  readonly brief: string;
  readonly details?: string;
  readonly coordinatorAgent: string;
}

export interface CreateWorkflowResult {
  readonly workflowId: string;
  readonly initialCoordNodeId: string;
}

export interface AddNodeArgs {
  readonly workflowId: string;
  readonly kind: NodeKind;
  readonly spec: unknown;
  readonly parents: ReadonlyArray<string>;
}

export interface AddNodeResult {
  readonly nodeId: string;
  readonly phase: number;
}

export interface AddEdgeArgs {
  readonly workflowId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

export interface AddEdgeResult {
  readonly toPhase: number;
}

export interface CancelNodeArgs {
  readonly workflowId: string;
  readonly nodeId: string;
}

export interface FinishWorkflowArgs {
  readonly workflowId: string;
  readonly outcome: "succeeded" | "failed";
}

export interface CancelWorkflowArgs {
  readonly workflowId: string;
}

export interface WorkflowDagSnapshot {
  readonly workflow: WorkflowEntity;
  readonly nodes: readonly WorkflowNodeEntity[];
  readonly edges: readonly WorkflowEdgeEntity[];
}

/**
 * Public surface for `@emploke/workflow`. Owns:
 *
 *   - reads + writes against `workflows` / `workflow_nodes` /
 *     `workflow_edges`
 *   - the per-kind runner dispatch indirection (runners injected at
 *     compose time, looked up via a closed `switch (kind)`)
 *   - the cross-cut auth gate: every mutation primitive except
 *     `cancelWorkflow` re-checks atomically that the caller is a
 *     running coordinator-kind node in a running workflow
 *   - the `dispatchAtomic` primitive that flips a node from
 *     `not_started|ready` → `running` and invokes the per-kind
 *     runner's `dispatch` outside the DB tx
 *
 * ## Compose-time wiring
 *
 * Runners are supplied through {@link composeWorkflowModule}, one per
 * value of `NodeKind`:
 *
 * ```ts
 * const wf = await composeWorkflowModule({
 *   dbFile,
 *   workspaceDir,
 *   runners: {
 *     coordinator: makeCoordinatorRunner({ sessions }),
 *     worker:      makeWorkerRunner({ tasks }),
 *   },
 * });
 * ```
 *
 * Adding a new kind is a substrate change: extend `NodeKind` and add
 * the matching `WorkflowRunners` field. TypeScript's exhaustiveness
 * catches any unhandled case at compile time, so a forgotten runner
 * cannot ship.
 *
 * ## Auth gate
 *
 * Every mutation method (except `cancelWorkflow`) takes an explicit
 * `workflowId` and the substrate **derives** the caller coordinator
 * (`C`) at the top of the mutation tx as the unique
 * `kind='coordinator' AND status='running'` row in that workflow
 * (per invariant #2). The cross-cut predicate
 *
 * ```text
 *   C.kind        = 'coordinator'
 * AND C.status      = 'running'
 * AND workflow.status = 'running'
 * ```
 *
 * is established by the derivation succeeding (1 row) plus a
 * workflow-status check; the inside-tx recheck against the derived
 * `C.id` (a JOIN read inside the write tx) defends against the race
 * window between derivation and write. Failure throws
 * {@link WorkflowMutationUnauthorizedError}. The legitimate handover
 * window (0 running coords between a coord's `finishWorkflow` and
 * the next coord spawning) cleanly rejects mutations with reason
 * `"no active caller coord ..."`; a defensive 2+-coord case
 * indicates schema corruption (invariant #2 violation).
 *
 * Workflow-level `cancelWorkflow` is an external operator API and
 * bypasses the derivation + auth gate; HTTP / IPC surface enforces
 * the operator's authority.
 */
export class WorkflowService {
  private readonly repo: WorkflowRepository;
  private readonly db: Db;
  private readonly workspaceDir: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly runners: WorkflowRunners;

  constructor(opts: WorkflowServiceOpts) {
    this.repo = opts.repo;
    this.db = opts.db;
    this.workspaceDir = opts.workspaceDir;
    this.runners = opts.runners;
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? (() => new Date());
    this.randomUUID = opts.randomUUID ?? (() => nodeRandomUUID());
  }

  /**
   * Resolve the runner for a `NodeKind`. Caller-supplied `kind`
   * values are TypeScript-checked against the closed enum, so the
   * `default` branch only fires for persisted-row corruption (an
   * older binary's removed kind value, a hand-edited DB row); it
   * throws {@link WorkflowNodeKindUnknownError} for diagnosis.
   */
  private runnerFor(kind: string): WorkflowNodeRunner {
    switch (kind) {
      case COORDINATOR_KIND:
        return this.runners.coordinator;
      case WORKER_KIND:
        return this.runners.worker;
      default:
        throw new WorkflowNodeKindUnknownError(kind);
    }
  }

  // ─── Reads ────────────────────────────────────────────────

  async getWorkflow(workflowId: string): Promise<WorkflowEntity> {
    const wf = await this.repo.readWorkflow(workflowId);
    if (wf === null) throw new WorkflowNotFoundError(workflowId);
    return wf;
  }

  async getDag(workflowId: string): Promise<WorkflowDagSnapshot> {
    const wf = await this.repo.readWorkflow(workflowId);
    if (wf === null) throw new WorkflowNotFoundError(workflowId);
    const [nodes, edges] = await Promise.all([
      this.repo.listNodesByWorkflow(workflowId),
      this.repo.listEdgesByWorkflow(workflowId),
    ]);
    return { workflow: wf, nodes, edges };
  }

  async getNode(nodeId: string): Promise<WorkflowNodeEntity> {
    const node = await this.repo.readNode(nodeId);
    if (node === null) throw new WorkflowNodeNotFoundError("<unknown>", nodeId);
    return node;
  }

  /**
   * Resolves the on-disk directory for a node, or `null` when the
   * directory is not yet considered live.
   *
   * Returned as `null` for nodes still in `not_started` or `ready`:
   * the directory is materialized at dispatch time, so callers (UI,
   * audit) would otherwise observe a path that doesn't exist on disk.
   * A vanishingly short window inside `dispatchAtomic` — after the
   * status has flipped to `running` but before `runner.dispatch`
   * actually creates the directory — may return the path before the
   * directory exists; callers must tolerate that.
   *
   * For `running` and all terminal statuses, returns the resolved
   * path (so audit / replay can find the unit's working directory
   * even after completion).
   */
  async getNodeDir(nodeId: string): Promise<string | null> {
    const node = await this.repo.readNode(nodeId);
    if (node === null) throw new WorkflowNodeNotFoundError("<unknown>", nodeId);
    if (node.status === "not_started" || node.status === "ready") return null;
    return workflowNodeDir(this.workspaceDir, node.workflowId, node.id);
  }

  // ─── createWorkflow ──────────────────────────────────────

  /**
   * Create a new workflow with its initial coordinator node attached.
   * The workflow row + the initial coord node row + the
   * `coordinator_agent` denorm are all inserted in one transaction;
   * the dispatch reaction fires AFTER the tx commits so the runner
   * never runs while a write lock is held.
   *
   * `coordinatorAgent` shape is validated as a non-empty string
   * (cross-package catalog validation is wired by the compose-layer
   * coordinator runner; the substrate stays shape-only here).
   */
  async createWorkflow(args: CreateWorkflowArgs): Promise<CreateWorkflowResult> {
    if (typeof args.brief !== "string" || args.brief.trim().length === 0) {
      throw new WorkflowError("createWorkflow: brief must be a non-empty string");
    }
    if (typeof args.coordinatorAgent !== "string" || args.coordinatorAgent.length === 0) {
      throw new WorkflowError("createWorkflow: coordinatorAgent must be a non-empty string");
    }

    const runner = this.runnerFor(COORDINATOR_KIND);
    const workflowId = generateWorkflowId(this.randomUUID);
    const initialCoordNodeId = generateWorkflowNodeId(this.randomUUID);
    const nowIso = this.now().toISOString();
    const coordSpec: { readonly agent: string } = { agent: args.coordinatorAgent };

    // The bootstrap insert is its own validate-context source: the
    // caller IS the node being validated, so callerCoordNodeId =
    // self and callerCoordSpec = self spec. The substrate treats
    // this as a degenerate but uniform case.
    const validateCtx: WorkflowNodeValidateCtx = {
      workflowId,
      callerCoordNodeId: initialCoordNodeId,
      callerCoordSpec: coordSpec,
      workflowStatus: "running",
    };
    const validatedSpec = await runner.validate(coordSpec, validateCtx);
    assertCoordinatorSpecAgent(validatedSpec);

    this.db.transaction((tx) => {
      const wfEntity = workflowEntityFor({
        id: workflowId,
        brief: args.brief,
        details: args.details,
        coordinatorAgent: validatedSpec.agent,
        nowIso,
      });
      this.repo.insertWorkflow(tx, wfEntity);
      this.insertCoordNodeInTx(tx, {
        workflowId,
        nodeId: initialCoordNodeId,
        validatedSpec,
        parents: [],
        nowIso,
      });
    });

    await this.dispatchAtomic(initialCoordNodeId);
    return { workflowId, initialCoordNodeId };
  }

  // ─── addNode ─────────────────────────────────────────────

  async addNode(args: AddNodeArgs): Promise<AddNodeResult> {
    // Structural precondition: every primitive insert must root in
    // the existing DAG. The initial coord (created via
    // `createWorkflow`) is the unique phase-0 entry point; every
    // subsequent node MUST list ≥1 parent. Fires BEFORE the
    // derivation so the rejection is order-independent of caller
    // state.
    if (args.parents.length === 0) {
      throw new EmptyParentsError();
    }

    const runner = this.runnerFor(args.kind);
    const nodeId = generateWorkflowNodeId(this.randomUUID);
    const nowIso = this.now().toISOString();

    // Phase A: derive the caller coord (`C`) from `args.workflowId`
    // and construct the validate ctx. `runner.validate` may do async
    // catalog lookups; it runs OUTSIDE the write tx so a network
    // round-trip never holds a write lock.
    const C = await this.deriveCallerCoord(args.workflowId);
    const validateCtx: WorkflowNodeValidateCtx = {
      workflowId: args.workflowId,
      callerCoordNodeId: C.id,
      callerCoordSpec: C.spec,
      workflowStatus: "running",
    };
    const workflowId = args.workflowId;

    const validatedSpec = await runner.validate(args.spec, validateCtx);

    // For coord-kind, the substrate needs `spec.agent` to maintain
    // `workflows.coordinator_agent`. Surface a clear error if the
    // runner returned a shape without it (mirrors invariant that
    // every coord spec carries an agent FQN).
    if (args.kind === COORDINATOR_KIND) {
      assertCoordinatorSpecAgent(validatedSpec);
    }

    let resultPhase = 0;
    let uniqueParents: readonly string[] = [];
    this.db.transaction((tx) => {
      // Defense-in-depth recheck: re-assert that C is still a
      // running coord in a running workflow. Catches a concurrent
      // caller-coord termination between Phase A and the write tx.
      this.assertAuthCallerCoord(tx, C.id, workflowId);

      // Read the parent set inside the tx.
      uniqueParents = Array.from(new Set(args.parents));
      const parentEntities = this.repo.readNodesByIds(tx, uniqueParents);
      if (parentEntities.length !== uniqueParents.length) {
        const found = new Set(parentEntities.map((p) => p.id));
        const missing = uniqueParents.find((p) => !found.has(p));
        if (missing !== undefined) throw new WorkflowNodeNotFoundError(workflowId, missing);
      }
      for (const p of parentEntities) {
        if (p.workflowId !== workflowId) {
          throw new WorkflowMutationUnauthorizedError(
            workflowId,
            C.id,
            `parent node "${p.id}" is in a different workflow`,
          );
        }
      }

      // Kind-aware parent-state restriction.
      if (args.kind === WORKER_KIND) {
        for (const p of parentEntities) {
          if (p.status === "failed" || p.status === "cancelled") {
            throw new ParentStateError(workflowId, args.kind, p.id, p.status);
          }
        }
      }

      if (args.kind === COORDINATOR_KIND) {
        if (!uniqueParents.includes(C.id)) {
          throw new OrphanCoordInsertError(workflowId, C.id);
        }
        // Caller MUST NOT already have a coord-kind child. Inspect
        // the live edge set + node kinds for any (caller → coord)
        // edge already present.
        const allEdges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
        const callerChildren = allEdges.filter((e) => e.from === C.id).map((e) => e.to);
        if (callerChildren.length > 0) {
          const childNodes = this.repo.readNodesByIds(tx, callerChildren);
          if (childNodes.some((c) => c.kind === COORDINATOR_KIND)) {
            throw new MultipleSuccessorCoordsError(workflowId, C.id);
          }
        }
      }

      const phase = computePhaseFromParents(parentEntities);
      resultPhase = phase;

      if (args.kind === COORDINATOR_KIND) {
        this.insertCoordNodeInTx(tx, {
          workflowId,
          nodeId,
          validatedSpec: validatedSpec as { agent: string },
          parents: uniqueParents,
          nowIso,
        });
      } else {
        const node = nodeEntityFor({
          id: nodeId,
          workflowId,
          kind: args.kind,
          spec: validatedSpec,
          phase,
          status: "not_started",
          nowIso,
        });
        this.repo.insertNode(tx, node);
        for (const p of uniqueParents) {
          this.repo.insertEdge(tx, { workflowId, from: p, to: nodeId });
        }
      }
    });

    // Post-commit eager-dispatch reaction. Without this, a coord that
    // adds a node whose parents are all already terminal would
    // deadlock — no future parent-termination event would ever fire
    // to wake the new node. `dispatchAtomic` re-checks readiness
    // atomically so a concurrent parent cancel is handled safely.
    const parentEntitiesForReadiness = await Promise.all(
      uniqueParents.map((id) => this.repo.readNode(id)),
    );
    const liveParents = parentEntitiesForReadiness.filter(
      (n): n is WorkflowNodeEntity => n !== null,
    );
    if (parentsReadyForKind(args.kind, liveParents)) {
      await this.dispatchAtomic(nodeId);
    }

    return { nodeId, phase: resultPhase };
  }

  // ─── addEdge ─────────────────────────────────────────────

  async addEdge(args: AddEdgeArgs): Promise<AddEdgeResult> {
    let resultToPhase = 0;
    let toKind = "";
    let toNodeStatusAfter: WorkflowNodeStatus = "not_started";
    let dispatchCandidates: string[] = [];

    // Derive `C` (and validate that `args.workflowId` is running)
    // outside the write tx; the inside-tx recheck below catches a
    // concurrent caller termination.
    const C = await this.deriveCallerCoord(args.workflowId);
    const workflowId = args.workflowId;

    this.db.transaction((tx) => {
      this.assertAuthCallerCoord(tx, C.id, workflowId);

      const endpoints = this.repo.readNodesByIds(tx, [args.fromNodeId, args.toNodeId]);
      const fromNode = endpoints.find((n) => n.id === args.fromNodeId);
      const toNode = endpoints.find((n) => n.id === args.toNodeId);
      if (fromNode === undefined) throw new WorkflowNodeNotFoundError(workflowId, args.fromNodeId);
      if (toNode === undefined) throw new WorkflowNodeNotFoundError(workflowId, args.toNodeId);

      if (fromNode.workflowId !== workflowId || toNode.workflowId !== workflowId) {
        throw new WorkflowMutationUnauthorizedError(
          workflowId,
          C.id,
          "edge endpoint(s) are in a different workflow",
        );
      }

      if (toNode.status !== "not_started") {
        throw new WorkflowNodeNotMutableError(workflowId, args.toNodeId, toNode.status, "addEdge");
      }

      // Kind-aware from-state by the to-node's kind. Worker-kind
      // dispatch needs every parent succeeded; coordinator-kind
      // dispatch accepts any terminal parent (wakes on failure).
      if (toNode.kind === WORKER_KIND) {
        if (fromNode.status === "failed" || fromNode.status === "cancelled") {
          throw new ParentStateError(workflowId, toNode.kind, fromNode.id, fromNode.status);
        }
      }

      // Cycle check on live DAG ∪ {new edge}. DFS from to-node
      // looking for from-node — if reachable, adding the edge
      // closes a cycle.
      const liveEdges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
      if (
        wouldCreateCycle(liveEdges, {
          from: args.fromNodeId,
          to: args.toNodeId,
        })
      ) {
        throw new WorkflowEdgeCycleError(workflowId, args.fromNodeId, args.toNodeId);
      }

      this.repo.insertEdge(tx, {
        workflowId,
        from: args.fromNodeId,
        to: args.toNodeId,
      });

      // Recompute phase across the not_started subtree rooted at
      // the to-node. Running / terminal descendants are sealed; the
      // recompute skips them so phase changes never touch a node
      // whose phase is already engaged by the dispatch loop.
      const phaseDiff = this.recomputePhasesInTx(tx, workflowId, args.toNodeId);
      this.repo.updateNodePhases(tx, phaseDiff);
      resultToPhase = phaseDiff.get(args.toNodeId) ?? toNode.phase;
      toKind = toNode.kind;
      toNodeStatusAfter = toNode.status;

      // Candidates for the post-commit dispatch reaction: the to-node
      // plus any not_started descendant whose phase was recomputed.
      // (The recompute set IS the set of not_started descendants.)
      dispatchCandidates = Array.from(phaseDiff.keys());
    });

    // Post-commit eager-dispatch reaction. dispatchAtomic re-checks
    // readiness inside its own tx, so a concurrent parent cancel
    // between this read and the dispatch tx is a no-op.
    void toKind;
    void toNodeStatusAfter;
    for (const candidateId of dispatchCandidates) {
      const node = await this.repo.readNode(candidateId);
      if (node === null) continue;
      if (node.status !== "not_started" && node.status !== "ready") continue;
      const allNodes = await this.repo.listNodesByWorkflow(node.workflowId);
      const allEdges = await this.repo.listEdgesByWorkflow(node.workflowId);
      const parents = parentsOf(node.id, allEdges)
        .map((pid) => allNodes.find((n) => n.id === pid))
        .filter((n): n is WorkflowNodeEntity => n !== undefined);
      if (parents.length === 0) {
        await this.dispatchAtomic(candidateId);
      } else if (parentsReadyForKind(node.kind, parents)) {
        await this.dispatchAtomic(candidateId);
      }
    }

    return { toPhase: resultToPhase };
  }

  // ─── cancelNode ──────────────────────────────────────────

  /**
   * Cancel a worker-kind node. Coord-kind cancellation is deferred —
   * cancel the workflow instead via `cancelWorkflow`.
   *
   * Allowed source statuses: `not_started`, `ready`, `running`. When
   * the node was running, `runner.cancel(nodeId)` is invoked AFTER
   * the tx commits (best-effort; the unit-of-work may still complete
   * after the cancel returns and its result is discarded).
   */
  async cancelNode(args: CancelNodeArgs): Promise<void> {
    let wasRunning = false;
    let nodeKind = "";

    // Derive `C` outside the write tx; the inside-tx recheck below
    // catches a concurrent caller termination.
    const C = await this.deriveCallerCoord(args.workflowId);
    const workflowId = args.workflowId;

    this.db.transaction((tx) => {
      this.assertAuthCallerCoord(tx, C.id, workflowId);
      const node = this.repo.readNodeTx(tx, args.nodeId);
      if (node === null) throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
      if (node.workflowId !== workflowId) {
        throw new WorkflowMutationUnauthorizedError(
          workflowId,
          C.id,
          `target node "${args.nodeId}" is in a different workflow`,
        );
      }
      if (node.kind !== WORKER_KIND) {
        throw new WorkflowNodeNotMutableError(workflowId, args.nodeId, node.status, "cancelNode");
      }
      const allowedSources: WorkflowNodeStatus[] = ["not_started", "ready", "running"];
      if (!allowedSources.includes(node.status)) {
        throw new WorkflowNodeNotMutableError(workflowId, args.nodeId, node.status, "cancelNode");
      }
      wasRunning = node.status === "running";
      nodeKind = node.kind;
      const nowIso = this.now().toISOString();
      this.repo.updateNodeLifecycle(tx, {
        id: args.nodeId,
        status: "cancelled",
        endedAt: nowIso,
      });
    });

    if (wasRunning) {
      const runner = this.runnerFor(nodeKind);
      try {
        await runner.cancel(args.nodeId);
      } catch (err) {
        this.logger.warn(
          { nodeId: args.nodeId, err },
          "cancelNode: runner.cancel failed (substrate state remains cancelled)",
        );
      }
    }
  }

  // ─── finishWorkflow ──────────────────────────────────────

  /**
   * Marks the workflow terminal. CAS-guarded so a second caller
   * cannot double-terminate; a 0-row result throws
   * {@link WorkflowAlreadyTerminalError}.
   *
   * The substrate **derives** the calling coordinator `C` from
   * `args.workflowId` at the top of the tx (while `C` is still
   * `running`); the local `C.id` is held across the CAS that flips
   * the workflow to terminal, so the subsequent cancel
   * reconciliation can correctly exclude the caller. Re-deriving
   * after the CAS would observe 0 running coords (or a stale C if
   * a future handover had already begun), defeating the
   * cancel-exclusion guarantee.
   *
   * Post-tx reconciliation: every non-terminal node in the workflow
   * EXCEPT the calling coord itself is cancelled via
   * `runner.cancel(node.id)` followed by `status='cancelled'`. The
   * caller is excluded so the substrate never cancels the task
   * currently inside `finishWorkflow`; the caller continues to its
   * natural exit and the eventual coord-termination handler (future
   * engine phase) flips it terminal.
   */
  async finishWorkflow(args: FinishWorkflowArgs): Promise<void> {
    if (args.outcome !== "succeeded" && args.outcome !== "failed") {
      throw new WorkflowError(
        `finishWorkflow: outcome must be 'succeeded' or 'failed', got "${args.outcome}"`,
      );
    }

    const workflowId = args.workflowId;
    const C = await this.deriveCallerCoord(workflowId);

    let casOk = false;
    const nowIso = this.now().toISOString();
    this.db.transaction((tx) => {
      // Re-check auth atomically with the CAS so a concurrent
      // caller-coord termination is caught here too.
      this.assertAuthCallerCoord(tx, C.id, workflowId);
      casOk = this.repo.casUpdateWorkflowStatus(tx, {
        id: workflowId,
        fromStatus: "running",
        toStatus: args.outcome,
        endedAt: nowIso,
      });
    });
    if (!casOk) throw new WorkflowAlreadyTerminalError(workflowId);

    // The locally-held C.id is used here — re-deriving after the
    // CAS would observe a terminal workflow and find 0 running
    // coords, so the exclusion would degrade to "exclude nothing".
    await this.reconcileCancelExceptCaller(workflowId, C.id);
  }

  // ─── cancelWorkflow ──────────────────────────────────────

  /**
   * External operator API — no caller-coord gate (surface-layer auth
   * governs caller authority). CAS-guarded; throws
   * {@link WorkflowAlreadyTerminalError} on a second call.
   *
   * Post-tx reconciliation cancels every non-terminal node in the
   * workflow (including any running coord — there is no caller to
   * exclude here).
   */
  async cancelWorkflow(args: CancelWorkflowArgs): Promise<void> {
    let casOk = false;
    const nowIso = this.now().toISOString();
    this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, args.workflowId);
      if (wf === null) throw new WorkflowNotFoundError(args.workflowId);
      casOk = this.repo.casUpdateWorkflowStatus(tx, {
        id: args.workflowId,
        fromStatus: "running",
        toStatus: "cancelled",
        endedAt: nowIso,
      });
    });
    if (!casOk) throw new WorkflowAlreadyTerminalError(args.workflowId);

    await this.reconcileCancelExceptCaller(args.workflowId, null);
  }

  // ─── dispatchAtomic ──────────────────────────────────────

  /**
   * Substrate primitive: flip a node from `not_started|ready` →
   * `running` and invoke its per-kind runner's `dispatch` AFTER
   * the tx commits. On dispatch throw, a separate tx writes
   * `status='failed'`.
   *
   * Inside the tx:
   *   - re-reads `workflow.status` (defends against cancel race)
   *   - re-reads `node.status` (defends against parallel dispatch)
   *   - re-checks per-kind parent readiness (defends against
   *     parent-cancel race between the eager-dispatch reaction and
   *     this method)
   *
   * If any check fails, the tx is a no-op and the method returns
   * silently — the substrate's invariant is "calling dispatchAtomic
   * is always safe; it does nothing when the node is not eligible".
   *
   * The runner invocation is OUTSIDE the tx because holding a
   * write lock across an async network call would serialize the
   * entire workflow engine on a slow dispatch.
   */
  async dispatchAtomic(nodeId: string): Promise<void> {
    let dispatchPayload: {
      readonly runner: WorkflowNodeRunner;
      readonly workflowId: string;
      readonly nodeId: string;
      readonly spec: unknown;
      readonly nodeDir: string;
    } | null = null;

    this.db.transaction((tx) => {
      const node = this.repo.readNodeTx(tx, nodeId);
      if (node === null) return;
      if (node.status !== "not_started" && node.status !== "ready") return;
      const wf = this.repo.readWorkflowTx(tx, node.workflowId);
      if (wf === null || wf.status !== "running") return;

      const runner = this.runnerFor(node.kind);

      // Per-kind parent readiness re-check inside the tx.
      const allEdges = this.repo.listEdgesByWorkflowTx(tx, node.workflowId);
      const parentIds = parentsOf(node.id, allEdges);
      const parents = this.repo.readNodesByIds(tx, parentIds);
      if (parentIds.length !== parents.length) return;
      if (parents.length > 0 && !parentsReadyForKind(node.kind, parents)) return;

      const nowIso = this.now().toISOString();
      this.repo.updateNodeLifecycle(tx, {
        id: nodeId,
        status: "running",
        runningAt: nowIso,
      });

      dispatchPayload = {
        runner,
        workflowId: node.workflowId,
        nodeId,
        spec: node.spec,
        nodeDir: workflowNodeDir(this.workspaceDir, node.workflowId, nodeId),
      };
    });

    if (dispatchPayload === null) return;
    const payload = dispatchPayload as {
      readonly runner: WorkflowNodeRunner;
      readonly workflowId: string;
      readonly nodeId: string;
      readonly spec: unknown;
      readonly nodeDir: string;
    };
    try {
      await payload.runner.dispatch({
        workflowId: payload.workflowId,
        nodeId: payload.nodeId,
        spec: payload.spec,
        nodeDir: payload.nodeDir,
      });
    } catch (err) {
      this.logger.warn(
        { nodeId, err },
        "dispatchAtomic: runner.dispatch threw; marking node failed",
      );
      const failedAtIso = this.now().toISOString();
      try {
        this.db.transaction((tx) => {
          this.repo.updateNodeLifecycle(tx, {
            id: nodeId,
            status: "failed",
            endedAt: failedAtIso,
          });
        });
      } catch (writeErr) {
        this.logger.error(
          { nodeId, err: writeErr },
          "dispatchAtomic: failed to write failed status after dispatch error",
        );
      }
    }
  }

  // ─── Internals ───────────────────────────────────────────

  /**
   * R4 caller-coord derivation: resolve the unique running
   * coordinator-kind node in `workflowId` (invariant #2 — at any
   * moment, at most 1 `kind='coordinator'` row in `status='running'`
   * per workflow). Wraps the substrate's SELECT in a read tx for
   * atomicity of the workflow-status check + the coord-list read.
   *
   * Branches:
   *   - **0 rows** → `WorkflowMutationUnauthorizedError` with reason
   *     `"no active caller coord (workflow terminal or handover
   *     window)"`. Covers the legitimate handover window between
   *     one coord's `finishWorkflow` and the next coord spawning,
   *     plus the "workflow is already terminal" case.
   *   - **1 row** → returns `{ id, spec }` where `spec` is the
   *     parsed coord spec (asserted to carry a non-empty `agent`
   *     FQN — invariant #11).
   *   - **2+ rows** → invariant #2 has been violated (schema
   *     corruption or substrate bug). Logs the violation and throws
   *     `WorkflowMutationUnauthorizedError` with reason `"multiple
   *     active coords — invariant #2 violated (schema corruption)"`.
   *     This is a defensive path; normal substrate operation cannot
   *     produce it.
   *
   * Workflow lifecycle errors:
   *   - Throws `WorkflowNotFoundError` when `workflowId` does not
   *     exist (caller-side typo or stale id).
   *
   * Used by every mutation primitive except `createWorkflow` (which
   * self-bootstraps with `C = self` for the just-allocated initial
   * coord) and `cancelWorkflow` (operator API; no caller
   * derivation, no auth gate).
   */
  private async deriveCallerCoord(workflowId: string): Promise<{
    readonly id: string;
    readonly spec: { readonly agent: string };
  }> {
    const result = this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) {
        return { kind: "not-found" as const };
      }
      if (wf.status !== "running") {
        return { kind: "wf-terminal" as const, wfStatus: wf.status };
      }
      const coords = this.repo.readRunningCoordsForWorkflow(tx, workflowId);
      return { kind: "coords" as const, coords };
    });

    if (result.kind === "not-found") {
      throw new WorkflowNotFoundError(workflowId);
    }
    if (result.kind === "wf-terminal") {
      throw new WorkflowMutationUnauthorizedError(
        workflowId,
        "<derived>",
        `no active caller coord (workflow status is "${result.wfStatus}", expected "running")`,
      );
    }
    const coords = result.coords;
    if (coords.length === 0) {
      throw new WorkflowMutationUnauthorizedError(
        workflowId,
        "<derived>",
        "no active caller coord (workflow terminal or handover window)",
      );
    }
    if (coords.length > 1) {
      this.logger.error(
        { workflowId, coordIds: coords.map((c) => c.id) },
        "deriveCallerCoord: invariant #2 violated — multiple coord-kind rows are status='running' in this workflow",
      );
      throw new WorkflowMutationUnauthorizedError(
        workflowId,
        "<derived>",
        "multiple active coords — invariant #2 violated (schema corruption)",
      );
    }
    const only = coords[0] as { readonly id: string; readonly specJson: string };
    const parsed = parseSpecJson(only.specJson);
    assertCoordinatorSpecAgent(parsed);
    return { id: only.id, spec: parsed };
  }

  /**
   * Cross-cut auth predicate. JOIN-backed read inside the caller's
   * tx so the (caller coord status, workflow status) pair is
   * evaluated atomically.
   *
   * After R4 this serves as the inside-tx defense-in-depth recheck
   * against the *derived* caller coord id ({@link deriveCallerCoord}
   * runs OUTSIDE the write tx; this recheck runs INSIDE), catching
   * the narrow race where the derived coord terminated between
   * derivation and the write tx.
   *
   * Returns the workflow id and the caller's coord spec for callers
   * that need them. Throws
   * {@link WorkflowMutationUnauthorizedError} on any failure.
   *
   * `expectedWorkflowId` is checked when present so a caller passing
   * a coord id from workflow A while operating on workflow B is
   * rejected as unauthorized rather than silently accepted.
   */
  private assertAuthCallerCoord(
    tx: Db,
    callerCoordNodeId: string,
    expectedWorkflowId?: string,
  ): { readonly workflowId: string; readonly callerSpec: { readonly agent: string } } {
    const ctx = this.repo.readCallerCoordContext(tx, callerCoordNodeId);
    if (ctx === null) {
      throw new WorkflowMutationUnauthorizedError(
        expectedWorkflowId ?? "<unknown>",
        callerCoordNodeId,
        "caller node not found",
      );
    }
    if (expectedWorkflowId !== undefined && ctx.callerWorkflowId !== expectedWorkflowId) {
      throw new WorkflowMutationUnauthorizedError(
        expectedWorkflowId,
        callerCoordNodeId,
        "caller is in a different workflow than the target",
      );
    }
    if (ctx.callerKind !== COORDINATOR_KIND) {
      throw new WorkflowMutationUnauthorizedError(
        ctx.callerWorkflowId,
        callerCoordNodeId,
        `caller kind is "${ctx.callerKind}", expected "${COORDINATOR_KIND}"`,
      );
    }
    if (ctx.callerStatus !== "running") {
      throw new WorkflowMutationUnauthorizedError(
        ctx.callerWorkflowId,
        callerCoordNodeId,
        `caller status is "${ctx.callerStatus}", expected "running"`,
      );
    }
    if (ctx.workflowStatus !== "running") {
      throw new WorkflowMutationUnauthorizedError(
        ctx.callerWorkflowId,
        callerCoordNodeId,
        `workflow status is "${ctx.workflowStatus}", expected "running"`,
      );
    }
    const parsed = parseSpecJson(ctx.callerSpecJson);
    assertCoordinatorSpecAgent(parsed);
    return { workflowId: ctx.callerWorkflowId, callerSpec: parsed };
  }

  /**
   * Package-internal helper: insert a coordinator-kind node row,
   * insert its parent edges, and UPDATE `workflows.coordinator_agent`
   * to the node's `spec.agent` — all inside the caller's tx so the
   * INSERT and the denormalization can never get out of sync.
   *
   * Used by both `createWorkflow` (initial coord, no parents) and
   * `addNode(kind='coordinator')` (subsequent coord, parents include
   * the caller).
   */
  private insertCoordNodeInTx(
    tx: Db,
    args: {
      readonly workflowId: string;
      readonly nodeId: string;
      readonly validatedSpec: { readonly agent: string };
      readonly parents: ReadonlyArray<string>;
      readonly nowIso: string;
    },
  ): void {
    const parentEntities = this.repo.readNodesByIds(tx, args.parents);
    const phase = computePhaseFromParents(parentEntities);
    const node = nodeEntityFor({
      id: args.nodeId,
      workflowId: args.workflowId,
      kind: COORDINATOR_KIND,
      spec: args.validatedSpec,
      phase,
      status: "not_started",
      nowIso: args.nowIso,
    });
    this.repo.insertNode(tx, node);
    for (const p of args.parents) {
      this.repo.insertEdge(tx, { workflowId: args.workflowId, from: p, to: args.nodeId });
    }
    // Inlined denormalization update — drizzle write inside the
    // caller's tx so the coord-node INSERT and the
    // `workflows.coordinator_agent` cache can never get out of
    // sync. The substrate exposes no public repo method for this
    // because `insertCoordNodeInTx` is the sole call site (used by
    // both `createWorkflow` and `addNode(kind='coordinator')`).
    tx.update(workflows)
      .set({ coordinatorAgent: args.validatedSpec.agent })
      .where(eq(workflows.id, args.workflowId))
      .run();
  }

  /**
   * Recompute phase across the `not_started` subtree rooted at
   * `startNodeId`. Skips running / terminal descendants — their
   * phase is sealed for the lifetime of the workflow because the
   * dispatch loop has already engaged.
   *
   * Returns the diff (id → new phase) so the caller can issue the
   * bulk UPDATE inside the same tx.
   */
  private recomputePhasesInTx(
    tx: Db,
    workflowId: string,
    startNodeId: string,
  ): Map<string, number> {
    const allNodes = this.repo.listNodesByWorkflowTx(tx, workflowId);
    const allEdges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const childrenOf = new Map<string, string[]>();
    const parentsOfMap = new Map<string, string[]>();
    for (const e of allEdges) {
      if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
      childrenOf.get(e.from)!.push(e.to);
      if (!parentsOfMap.has(e.to)) parentsOfMap.set(e.to, []);
      parentsOfMap.get(e.to)!.push(e.from);
    }

    const start = byId.get(startNodeId);
    const inScope = new Set<string>();
    if (start !== undefined && start.status === "not_started") {
      inScope.add(startNodeId);
      const queue: string[] = [startNodeId];
      while (queue.length > 0) {
        const cur = queue.shift() as string;
        for (const c of childrenOf.get(cur) ?? []) {
          if (inScope.has(c)) continue;
          const node = byId.get(c);
          if (node?.status === "not_started") {
            inScope.add(c);
            queue.push(c);
          }
        }
      }
    }

    // Topo sort (Kahn) restricted to in-scope nodes. In-degree is
    // the count of parents that are also in-scope; out-of-scope
    // parents (terminal / running) contribute a sealed phase but
    // not an unresolved dependency.
    const indeg = new Map<string, number>();
    for (const id of inScope) {
      let d = 0;
      for (const p of parentsOfMap.get(id) ?? []) {
        if (inScope.has(p)) d++;
      }
      indeg.set(id, d);
    }
    const ready: string[] = [];
    for (const [id, d] of indeg) if (d === 0) ready.push(id);

    const diff = new Map<string, number>();
    while (ready.length > 0) {
      const cur = ready.shift() as string;
      const parentIds = parentsOfMap.get(cur) ?? [];
      let maxParentPhase = -1;
      for (const p of parentIds) {
        const ph = diff.has(p) ? (diff.get(p) as number) : (byId.get(p)?.phase ?? -1);
        if (ph > maxParentPhase) maxParentPhase = ph;
      }
      diff.set(cur, maxParentPhase + 1);
      for (const c of childrenOf.get(cur) ?? []) {
        if (!inScope.has(c)) continue;
        const nd = (indeg.get(c) ?? 0) - 1;
        indeg.set(c, nd);
        if (nd === 0) ready.push(c);
      }
    }
    return diff;
  }

  /**
   * Shared cancel-reconciliation path used by `finishWorkflow` and
   * `cancelWorkflow`. Loads the live non-terminal node set OUTSIDE
   * a write tx, calls `runner.cancel` for each, then writes
   * `status='cancelled'` in a per-node tx.
   *
   * `excludeNodeId` excludes the calling coord in the `finishWorkflow`
   * flow so the substrate never cancels the very task that's still
   * inside the call frame.
   */
  private async reconcileCancelExceptCaller(
    workflowId: string,
    excludeNodeId: string | null,
  ): Promise<void> {
    const nodes = await this.repo.listNodesByWorkflow(workflowId);
    const targets = nodes.filter(
      (n) =>
        n.id !== excludeNodeId &&
        (n.status === "not_started" || n.status === "ready" || n.status === "running"),
    );
    for (const node of targets) {
      if (node.status === "running") {
        const runner = this.runnerFor(node.kind);
        try {
          await runner.cancel(node.id);
        } catch (err) {
          this.logger.warn(
            { nodeId: node.id, err },
            "reconcile: runner.cancel failed (substrate marks cancelled regardless)",
          );
        }
      }
      const nowIso = this.now().toISOString();
      try {
        this.db.transaction((tx) => {
          // CAS: only flip non-terminal nodes. A concurrent terminate
          // for the same node wins; this writer becomes a no-op.
          const fresh = this.repo.readNodeTx(tx, node.id);
          if (fresh === null) return;
          if (
            fresh.status !== "not_started" &&
            fresh.status !== "ready" &&
            fresh.status !== "running"
          ) {
            return;
          }
          this.repo.updateNodeLifecycle(tx, {
            id: node.id,
            status: "cancelled",
            endedAt: nowIso,
          });
        });
      } catch (err) {
        this.logger.warn({ nodeId: node.id, err }, "reconcile: writing cancelled status failed");
      }
    }
  }
}

import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import {
  COORDINATOR_KIND,
  classifyStuckReason,
  computePhaseFromParents,
  type NodeRef,
  nodeEntityFor,
  normalizeSubgraphInput,
  parentsOf,
  parentsReadyForKind,
  resolveSubgraphTopology,
  type SubgraphEdgeShape,
  type SubgraphTempNodeShape,
  structuralLeaves,
  validateSubgraphShape,
  WORKER_KIND,
  workflowEntityFor,
  wouldCreateCycle,
} from "./_dag.js";
import { assertCoordinatorSpecAgent, safeRmDir } from "./_helpers.js";
import {
  EmptyParentsError,
  MultipleSuccessorCoordsError,
  OrphanCoordInsertError,
  ParentStateError,
  WorkflowAlreadyTerminalError,
  WorkflowDagInvariantError,
  WorkflowEdgeCycleError,
  WorkflowEdgeNotFoundError,
  WorkflowError,
  WorkflowNodeKindCorruptionError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
  WorkflowNotFoundError,
  WorkflowRemoveEdgeOrphansChildError,
  WorkflowRemoveNodeOrphansChildError,
  WorkflowSubgraphCyclicError,
  WorkflowSubgraphEmptyError,
  WorkflowSubgraphNodeRefUnresolvedError,
} from "./errors.js";
import { workflowDir, workflowNodeDir } from "./paths.js";
import type * as schema from "./schema.js";
import { workflows } from "./schema.js";
import type {
  NodeKind,
  NodeRetryMetadata,
  RetryReason,
  SubstrateFailureReason,
  WorkflowCancellation,
  WorkflowFailure,
  WorkflowNodeRunner,
  WorkflowNodeStatus,
  WorkflowNodeTerminalResult,
  WorkflowNodeValidateCtx,
  WorkflowRunners,
  WorkflowSuccess,
} from "./types.js";
import { assertValidWorkflowId, generateWorkflowId, generateWorkflowNodeId } from "./validate.js";
import {
  extractNodeRetryMetadata,
  type WorkflowEdgeEntity,
  type WorkflowEntity,
  type WorkflowNodeEntity,
} from "./workflow-entity.js";
import type { WorkflowRepository } from "./workflow-repository.js";

type Db = BetterSQLite3Database<typeof schema>;

const silentLogger: Logger = pino({ level: "silent" });

/**
 * Maximum number of consecutive retry-coord insertions per stuck-
 * workflow chain. See {@link WorkflowService.checkStuckAndRecoverInTx}
 * for the rationale; five is the locked operational ceiling.
 */
export const STUCK_RETRY_MAX_ATTEMPTS = 5;

/**
 * Structured {@link WorkflowFailure} reason persisted on the workflow
 * row when the stuck-coord detector trips the
 * {@link STUCK_RETRY_MAX_ATTEMPTS} cap. The detector transitions the
 * workflow to `failed` with `{ kind: 'substrate', reason:
 * STUCK_RETRY_LIMIT }` in the same tx as the triggering mutation;
 * the dashboard surfaces the reason on the workflow's Overview
 * failure callout.
 */
export const STUCK_RETRY_LIMIT: SubstrateFailureReason = "STUCK_RETRY_LIMIT";

/**
 * Engine seam the service uses to nudge the in-memory
 * {@link WorkflowEngine} after every mutation tx commits. Kept as a
 * narrow structural type so the service file does not import the
 * engine class directly (preserving the one-way engine → service
 * import direction; the cycle is broken by the engine living in
 * `_engine.ts` and the service receiving the engine via a setter
 * called from `compose.ts` after both have been constructed).
 */
export interface WorkflowEngineLike {
  triggerWorkflowTick(workflowId: string): void;
}

export interface WorkflowServiceOpts {
  readonly repo: WorkflowRepository;
  readonly db: Db;
  readonly workspaceDir: string;
  readonly runners: WorkflowRunners;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  /**
   * Injectable seam for `generateWorkflowId` — workflow ids carry a
   * UTC date prefix + 4 random bytes (mirroring `generateTaskId`).
   * Tests stub this to produce deterministic ids; production callers
   * leave it unset to use `node:crypto.randomBytes`.
   */
  readonly randomBytes?: (n: number) => Buffer;
}

export interface CreateWorkflowArgs {
  readonly brief: string;
  readonly details?: string;
  readonly coordinatorAgent: string;
  /**
   * Opaque caller-supplied metadata persisted onto the workflow row.
   * Forwarded verbatim to {@link WorkflowEntity.metadata}; defaults
   * to `{}` when omitted.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
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

/**
 * Args accepted by {@link WorkflowService.finishWorkflow}. Discriminated
 * on `outcome`:
 *
 *   - `succeeded` — optional {@link WorkflowSuccess} payload. When
 *     omitted, the substrate persists `{ output: null }` so the row
 *     still satisfies the "succeeded ⇒ success non-null" invariant.
 *   - `failed` — required {@link WorkflowFailure} payload. Coord
 *     MUST supply a human-readable failure to surface in the
 *     dashboard's Overview tab.
 *
 * `cancelled` is NOT an arm here — workflow cancellation is the
 * external-operator route ({@link WorkflowService.cancelWorkflow}),
 * not a coord-driven path.
 */
export type FinishWorkflowArgs =
  | {
      readonly workflowId: string;
      readonly outcome: "succeeded";
      readonly success?: WorkflowSuccess;
    }
  | {
      readonly workflowId: string;
      readonly outcome: "failed";
      readonly failure: WorkflowFailure;
    };

/**
 * Args accepted by {@link WorkflowService.cancelWorkflow}. The
 * `cancellation` payload is REQUIRED — operator MUST supply at
 * least a kind + message. The server route defaults `kind='user'`
 * when omitted on the wire.
 */
export interface CancelWorkflowArgs {
  readonly workflowId: string;
  readonly cancellation: WorkflowCancellation;
}

export interface RemoveNodeArgs {
  readonly workflowId: string;
  readonly nodeId: string;
}

export interface RemoveEdgeArgs {
  readonly workflowId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

export interface ReplaceNodeSpecArgs {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly newSpec: unknown;
}

export interface AddSubgraphNodeInput {
  readonly tempId: string;
  readonly kind: NodeKind;
  readonly spec: unknown;
  readonly existingParents?: ReadonlyArray<string>;
}

export interface AddSubgraphEdgeInput {
  readonly from: NodeRef;
  readonly to: NodeRef;
}

export interface AddSubgraphArgs {
  readonly workflowId: string;
  readonly nodes: ReadonlyArray<AddSubgraphNodeInput>;
  readonly edges: ReadonlyArray<AddSubgraphEdgeInput>;
}

export interface AddSubgraphInsertedNode {
  readonly tempId: string;
  readonly nodeId: string;
  readonly phase: number;
}

export interface AddSubgraphResult {
  readonly insertedNodes: ReadonlyArray<AddSubgraphInsertedNode>;
}

export interface WorkflowDagSnapshot {
  readonly workflow: WorkflowEntity;
  readonly nodes: readonly WorkflowNodeEntity[];
  readonly edges: readonly WorkflowEdgeEntity[];
}

/**
 * Internal closure-state type used by the eight mutation primitives
 * to capture the {@link WorkflowService.checkStuckAndRecoverInTx}
 * outcome from inside the tx callback. Hoisted to a named alias so
 * the closure-scoped variable doesn't collapse to `never` under the
 * compiler's flow-narrowing of the discriminated union initializer.
 */
type StuckRecoveryOutcome =
  | { readonly inserted: false }
  | {
      readonly inserted: true;
      readonly retryNodeId: string;
      readonly reason: RetryReason;
      readonly attempt: number;
    };

/**
 * Public surface for `@emploke/workflow`. Owns:
 *
 *   - reads + writes against `workflows` / `workflow_nodes` /
 *     `workflow_edges`
 *   - the per-kind runner dispatch indirection (runners injected at
 *     compose time, looked up via a closed `switch (kind)`)
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
 * ## Workflow lifecycle gate
 *
 * Mutation primitives require the workflow to be in `status='running'`.
 * The substrate re-reads the workflow row inside every mutation tx
 * and rejects with {@link WorkflowNotFoundError} when the row is gone
 * or with {@link WorkflowAlreadyTerminalError} when the workflow has
 * already terminated. There is no per-caller authorization gate —
 * the HTTP / IPC surface is responsible for enforcing operator
 * authority.
 */
export class WorkflowService {
  private readonly repo: WorkflowRepository;
  private readonly db: Db;
  private readonly workspaceDir: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly randomBytes: (n: number) => Buffer;
  private readonly runners: WorkflowRunners;
  private engine: WorkflowEngineLike | null;

  constructor(opts: WorkflowServiceOpts) {
    this.repo = opts.repo;
    this.db = opts.db;
    this.workspaceDir = opts.workspaceDir;
    this.runners = opts.runners;
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? (() => new Date());
    this.randomUUID = opts.randomUUID ?? (() => nodeRandomUUID());
    this.randomBytes = opts.randomBytes ?? ((n: number) => nodeRandomBytes(n));
    this.engine = null;
  }

  /**
   * Two-phase init seam: `WorkflowService` and `WorkflowEngine` form
   * a tight cycle (the service nudges the engine after each tx
   * commits; the engine calls back into the service via
   * {@link markNodeTerminal} and {@link dispatchAtomic} from its tick
   * loop). `compose.ts` constructs both then calls this setter so
   * neither class needs a partially-constructed sibling in its
   * constructor.
   *
   * Idempotent — re-setting the same engine is a no-op; passing a
   * different engine logs a warning and overwrites (only happens in
   * tests that swap engines).
   */
  setEngine(engine: WorkflowEngineLike | null): void {
    if (this.engine !== null && engine !== null && this.engine !== engine) {
      this.logger.warn("WorkflowService.setEngine: engine being replaced (test-only path)");
    }
    this.engine = engine;
  }

  /**
   * Post-commit hook fired by every mutation method that could
   * change readiness. Safe to call when no engine is wired (existing
   * service tests, plus code paths that haven't yet had the engine
   * plugged in) — the no-op behavior matches the pre-engine shape,
   * so all 207 baseline workflow tests continue to pass with no
   * engine attached.
   */
  private nudgeEngine(workflowId: string): void {
    if (this.engine === null) return;
    try {
      this.engine.triggerWorkflowTick(workflowId);
    } catch (err) {
      this.logger.warn({ workflowId, err }, "nudgeEngine: triggerWorkflowTick threw");
    }
  }

  /**
   * Engine-facing read primitive: enumerate the node ids in
   * `workflowId` that are currently eligible for dispatch — i.e.
   * status is `not_started` or `ready` AND per-kind parent readiness
   * is satisfied (or the node has no parents).
   *
   * Returns node ids only (the engine re-reads each node fresh inside
   * `dispatchAtomic` anyway). Computed inside a single read tx for a
   * consistent snapshot. The engine treats the returned list as a
   * best-effort hint: `dispatchAtomic` re-checks each gate inside
   * its own write tx, so a node that becomes ineligible between this
   * read and the dispatch tx is silently no-op'd.
   */
  async listEligibleNodeIdsForDispatch(workflowId: string): Promise<readonly string[]> {
    return this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null || wf.status !== "running") return [] as readonly string[];
      const nodes = this.repo.listNodesByWorkflowTx(tx, workflowId);
      const edges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
      const byId = new Map(nodes.map((n) => [n.id, n] as const));
      const eligible: string[] = [];
      for (const node of nodes) {
        if (node.status !== "not_started" && node.status !== "ready") continue;
        const parentIds = parentsOf(node.id, edges);
        const parents = parentIds
          .map((pid) => byId.get(pid))
          .filter((p): p is WorkflowNodeEntity => p !== undefined);
        if (parents.length !== parentIds.length) continue;
        if (parents.length > 0 && !parentsReadyForKind(node.kind, parents)) continue;
        eligible.push(node.id);
      }
      return eligible;
    });
  }

  /**
   * Resolve the runner for a `NodeKind`. Caller-supplied `kind`
   * values are TypeScript-checked against the closed enum, so the
   * `default` branch only fires for persisted-row corruption (an
   * older binary's removed kind value, a hand-edited DB row); it
   * throws {@link WorkflowNodeKindCorruptionError} for diagnosis.
   */
  private runnerFor(kind: string): WorkflowNodeRunner {
    switch (kind) {
      case COORDINATOR_KIND:
        return this.runners.coordinator;
      case WORKER_KIND:
        return this.runners.worker;
      default:
        throw new WorkflowNodeKindCorruptionError(kind);
    }
  }

  // ─── Reads ────────────────────────────────────────────────

  async getWorkflow(workflowId: string): Promise<WorkflowEntity> {
    const wf = await this.repo.readWorkflow(workflowId);
    if (wf === null) throw new WorkflowNotFoundError(workflowId);
    return wf;
  }

  /**
   * Unbounded list of workflow headers in this workspace, ordered by
   * `created_at` descending (newest first). All three filter slots
   * are AND-combined when supplied; omitted slots widen the result
   * set. Caller-facing validation lives at the route boundary (the
   * substrate stays kind-agnostic about wire-shape vocabularies).
   *
   *   - `coordinatorAgent` — exact-match on `coordinator_agent`
   *     (uses the `workflows_coordinator_agent_idx` index).
   *   - `createdSince`     — ISO 8601 lower bound (inclusive) on
   *     `created_at`. Absent = unbounded.
   *   - `idLike`           — case-sensitive substring match on the
   *     workflow id; the repository escapes `LIKE` metacharacters so
   *     a `%` typed into the search box doesn't widen the match.
   *
   * Per-workspace volume is small enough that pagination is not yet
   * needed — same shape as `ScheduleService.list` /
   * `TaskService.list`.
   */
  async list(opts?: {
    readonly coordinatorAgent?: string;
    readonly createdSince?: string;
    readonly idLike?: string;
  }): Promise<readonly WorkflowEntity[]> {
    return this.repo.listWorkflows(opts);
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
    const workflowId = generateWorkflowId(this.now, this.randomBytes);
    const initialCoordNodeId = generateWorkflowNodeId(this.randomUUID);
    const nowIso = this.now().toISOString();
    const coordSpec: { readonly agent: string } = { agent: args.coordinatorAgent };

    const validateCtx: WorkflowNodeValidateCtx = {
      workflowId,
      workflowStatus: "running",
      // W3 plumbing: bootstrap path — the coord about to be installed
      // is the one whose dispatch menu future worker validates must
      // resolve against. See WorkflowNodeValidateCtx.coordinatorAgent.
      coordinatorAgent: args.coordinatorAgent,
    };
    const validatedSpec = await runner.validate(coordSpec, validateCtx);
    assertCoordinatorSpecAgent(validatedSpec);

    // Reserve (mkdir) the per-workflow shared dir BEFORE inserting
    // the workflows row so a mkdir failure leaves no orphan row.
    // Mirrors `@emploke/task`'s `dispatch` flow, which reserves the
    // workdir before the row insert + `safeRm` on rollback. The dir
    // is empty on creation; the coordinator owns the internal
    // layout.
    //
    // Order matters: mkdir → tx → if tx fails, `safeRmDir`. A dir-
    // without-row is rolled back here; a row-without-dir is
    // impossible because the mkdir happens first.
    const wfDir = workflowDir(this.workspaceDir, workflowId);
    await mkdir(wfDir, { recursive: true });

    try {
      this.db.transaction((tx) => {
        const wfEntity = workflowEntityFor({
          id: workflowId,
          brief: args.brief,
          details: args.details,
          coordinatorAgent: validatedSpec.agent,
          ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
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
    } catch (err) {
      await safeRmDir(wfDir, this.logger);
      throw err;
    }

    await this.dispatchAtomic(initialCoordNodeId);
    this.nudgeEngine(workflowId);
    return { workflowId, initialCoordNodeId };
  }

  // ─── purge ──────────────────────────────────────────────

  /**
   * Remove a workflow's shared dir at
   * `<workspaceDir>/workflows/<workflowId>/`.
   *
   * Idempotent — no-op if the dir does not exist (a second `purge`
   * call after the first one removed the dir is silent). Does NOT
   * remove the workflow row; the workflow row + audit trail in the
   * DB are owned by the workflow lifecycle, not the fs.
   *
   * Intended for operator cleanup of terminal workflows whose
   * audit logs are no longer needed (the `emploke workflow purge
   * --wfid X` subcommand wraps this) and for any future external-
   * sweep job. Workspace deletion already cascades the entire
   * `<workspaceDir>/workflows/` tree transitively via the workspace
   * service's `fs.rm` — `purge` is the per-workflow scoped variant.
   *
   * `workflowId` shape is validated to prevent a malformed caller-
   * supplied id from escaping the workspaceDir; the underlying
   * `workflowDir` helper also rejects path-traversal components as
   * defense in depth.
   *
   * Failure-mode: a real fs error (e.g. EBUSY) is warn-logged via
   * the service logger and NOT rethrown. Callers cannot do anything
   * useful with an `rm` error.
   */
  async purge(workflowId: string): Promise<void> {
    assertValidWorkflowId(workflowId);
    const wfDir = workflowDir(this.workspaceDir, workflowId);
    await safeRmDir(wfDir, this.logger);
  }

  // ─── addNode ─────────────────────────────────────────────

  async addNode(args: AddNodeArgs): Promise<AddNodeResult> {
    // Structural precondition: every primitive insert must root in
    // the existing DAG. The initial coord (created via
    // `createWorkflow`) is the unique phase-0 entry point; every
    // subsequent node MUST list ≥1 parent.
    if (args.parents.length === 0) {
      throw new EmptyParentsError();
    }

    const runner = this.runnerFor(args.kind);
    const nodeId = generateWorkflowNodeId(this.randomUUID);
    const nowIso = this.now().toISOString();
    const workflowId = args.workflowId;

    // Lifecycle gate: the target workflow must exist and be running.
    // Read OUTSIDE the write tx for the validate path; re-checked
    // inside the tx for atomicity against concurrent termination.
    // The returned entity carries the denormalized `coordinatorAgent`
    // we thread into the validate ctx so the worker runner can enforce
    // W3 (menu-membership) without an extra read.
    const wfRow = await this.assertWorkflowRunning(workflowId);

    // Phase A: pre-validate outside the tx so a runner's potentially
    // async validate runs without holding a write lock.
    const validateCtx: WorkflowNodeValidateCtx = {
      workflowId,
      workflowStatus: "running",
      coordinatorAgent: wfRow.coordinatorAgent,
    };
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
    let retryResult: StuckRecoveryOutcome = { inserted: false };
    this.db.transaction((tx) => {
      // Defense-in-depth: re-check workflow is still running inside
      // the write tx.
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) throw new WorkflowNotFoundError(workflowId);
      if (wf.status !== "running") throw new WorkflowAlreadyTerminalError(workflowId);

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
          throw new WorkflowNodeNotFoundError(workflowId, p.id);
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
        // Structural coord-chain rules. A new coord must descend
        // structurally from an existing coord; each coord predecessor
        // may have at most one coord-kind child.
        const coordParents = parentEntities.filter((p) => p.kind === COORDINATOR_KIND);
        if (coordParents.length === 0) {
          throw new OrphanCoordInsertError(workflowId);
        }
        const allEdges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
        for (const coordParent of coordParents) {
          const childIds = allEdges.filter((e) => e.from === coordParent.id).map((e) => e.to);
          if (childIds.length === 0) continue;
          const childNodes = this.repo.readNodesByIds(tx, childIds);
          if (childNodes.some((c) => c.kind === COORDINATOR_KIND)) {
            throw new MultipleSuccessorCoordsError(workflowId, coordParent.id);
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

      retryResult = this.checkStuckAndRecoverInTx(tx, workflowId, nowIso);
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

    await this.dispatchRetryIfInserted(retryResult);

    this.nudgeEngine(workflowId);
    return { nodeId, phase: resultPhase };
  }

  // ─── addEdge ─────────────────────────────────────────────

  async addEdge(args: AddEdgeArgs): Promise<AddEdgeResult> {
    let resultToPhase = 0;
    let toKind = "";
    let toNodeStatusAfter: WorkflowNodeStatus = "not_started";
    let dispatchCandidates: string[] = [];
    let retryResult: StuckRecoveryOutcome = { inserted: false };

    const workflowId = args.workflowId;

    this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) throw new WorkflowNotFoundError(workflowId);
      if (wf.status !== "running") throw new WorkflowAlreadyTerminalError(workflowId);

      const endpoints = this.repo.readNodesByIds(tx, [args.fromNodeId, args.toNodeId]);
      const fromNode = endpoints.find((n) => n.id === args.fromNodeId);
      const toNode = endpoints.find((n) => n.id === args.toNodeId);
      if (fromNode === undefined) throw new WorkflowNodeNotFoundError(workflowId, args.fromNodeId);
      if (toNode === undefined) throw new WorkflowNodeNotFoundError(workflowId, args.toNodeId);

      if (fromNode.workflowId !== workflowId) {
        throw new WorkflowNodeNotFoundError(workflowId, fromNode.id);
      }
      if (toNode.workflowId !== workflowId) {
        throw new WorkflowNodeNotFoundError(workflowId, toNode.id);
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
      const phaseDiff = this.recomputePhasesInTx(tx, workflowId, [args.toNodeId]);
      this.repo.updateNodePhases(tx, phaseDiff);
      resultToPhase = phaseDiff.get(args.toNodeId) ?? toNode.phase;
      toKind = toNode.kind;
      toNodeStatusAfter = toNode.status;

      // Candidates for the post-commit dispatch reaction: the to-node
      // plus any not_started descendant whose phase was recomputed.
      // (The recompute set IS the set of not_started descendants.)
      dispatchCandidates = Array.from(phaseDiff.keys());

      const nowIso = this.now().toISOString();
      retryResult = this.checkStuckAndRecoverInTx(tx, workflowId, nowIso);
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

    await this.dispatchRetryIfInserted(retryResult);

    this.nudgeEngine(workflowId);
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
    let retryResult: StuckRecoveryOutcome = { inserted: false };

    const workflowId = args.workflowId;

    this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) throw new WorkflowNotFoundError(workflowId);
      if (wf.status !== "running") throw new WorkflowAlreadyTerminalError(workflowId);
      const node = this.repo.readNodeTx(tx, args.nodeId);
      if (node === null) throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
      if (node.workflowId !== workflowId) {
        throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
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
      retryResult = this.checkStuckAndRecoverInTx(tx, workflowId, nowIso);
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
    await this.dispatchRetryIfInserted(retryResult);
    this.nudgeEngine(workflowId);
  }

  // ─── finishWorkflow ──────────────────────────────────────

  /**
   * Marks the workflow terminal. CAS-guarded so a concurrent caller
   * cannot double-terminate; a 0-row CAS result throws
   * {@link WorkflowAlreadyTerminalError}.
   *
   * Post-tx reconciliation: every non-terminal worker node and any
   * non-running coord node in the workflow is cancelled via
   * `runner.cancel(node.id)` followed by `status='cancelled'`. The
   * currently-running coord(s) are left alone so the calling coord
   * task can finish its in-flight call frame naturally; the substrate
   * never cancels the very task that is sitting inside `finishWorkflow`.
   */
  async finishWorkflow(args: FinishWorkflowArgs): Promise<void> {
    if (args.outcome !== "succeeded" && args.outcome !== "failed") {
      throw new WorkflowError(
        `finishWorkflow: outcome must be 'succeeded' or 'failed', got "${(args as { outcome: string }).outcome}"`,
      );
    }

    // Resolve the terminal-payload JSON to persist. Mirrors the
    // task substrate's `success`/`failure`/`cancellation` JSON
    // columns: exactly one is non-null per terminal status.
    let successJson: string | undefined;
    let failureJson: string | undefined;
    if (args.outcome === "succeeded") {
      const success: WorkflowSuccess = args.success ?? { output: null };
      if (typeof success !== "object" || success === null) {
        throw new WorkflowError("finishWorkflow: success must be an object when supplied");
      }
      if (success.output !== null && typeof success.output !== "string") {
        throw new WorkflowError("finishWorkflow: success.output must be a string or null");
      }
      successJson = JSON.stringify(success);
    } else {
      if (args.failure === undefined || typeof args.failure !== "object" || args.failure === null) {
        throw new WorkflowError("finishWorkflow: failure is required when outcome='failed'");
      }
      if (typeof args.failure.message !== "string") {
        throw new WorkflowError("finishWorkflow: failure.message must be a string");
      }
      if (args.failure.kind !== "coordinator") {
        throw new WorkflowError("finishWorkflow: failure.kind must be 'coordinator'");
      }
      failureJson = JSON.stringify(args.failure);
    }

    const workflowId = args.workflowId;

    let casOk = false;
    const nowIso = this.now().toISOString();
    this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) throw new WorkflowNotFoundError(workflowId);
      casOk = this.repo.casUpdateWorkflowStatus(tx, {
        id: workflowId,
        fromStatus: "running",
        toStatus: args.outcome,
        endedAt: nowIso,
        ...(successJson !== undefined ? { successJson } : {}),
        ...(failureJson !== undefined ? { failureJson } : {}),
      });
    });
    if (!casOk) throw new WorkflowAlreadyTerminalError(workflowId);

    await this.reconcileCancel(workflowId, { excludeRunningCoords: true });
    this.nudgeEngine(workflowId);
  }

  // ─── cancelWorkflow ──────────────────────────────────────

  /**
   * External operator API. CAS-guarded; throws
   * {@link WorkflowAlreadyTerminalError} on a second call.
   *
   * Post-tx reconciliation cancels every non-terminal node in the
   * workflow including any running coord (the operator's authority
   * to cancel covers the live coord too).
   *
   * The {@link WorkflowCancellation} payload is persisted in the
   * same UPDATE as the status flip, mirroring `finishWorkflow`'s
   * `success`/`failure` columns.
   */
  async cancelWorkflow(args: CancelWorkflowArgs): Promise<void> {
    if (
      args.cancellation === undefined ||
      typeof args.cancellation !== "object" ||
      args.cancellation === null
    ) {
      throw new WorkflowError("cancelWorkflow: cancellation payload is required");
    }
    if (typeof args.cancellation.message !== "string") {
      throw new WorkflowError("cancelWorkflow: cancellation.message must be a string");
    }
    if (args.cancellation.kind !== "user") {
      throw new WorkflowError("cancelWorkflow: cancellation.kind must be 'user'");
    }
    const cancellationJson = JSON.stringify(args.cancellation);

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
        cancellationJson,
      });
    });
    if (!casOk) throw new WorkflowAlreadyTerminalError(args.workflowId);

    await this.reconcileCancel(args.workflowId, { excludeRunningCoords: false });
    this.nudgeEngine(args.workflowId);
  }

  // ─── removeNode ──────────────────────────────────────────

  /**
   * Delete a node from the workflow. Allowed only when:
   *
   *   - the workflow is `running` and the caller is the unique
   *     running coord (cross-cut auth gate);
   *   - the target node belongs to this workflow;
   *   - the target node's status is `not_started` (sealing rule —
   *     once dispatch engages, the row is immutable);
   *   - no child of the node would be left with zero parents after
   *     the delete (orphan rule —
   *     {@link WorkflowRemoveNodeOrphansChildError}).
   *
   * All adjacent edges (both incoming and outgoing) are deleted in
   * the same write tx. After the row + edge deletes commit, the
   * not_started descendant phases are recomputed (the removed node
   * may have been the longest-path predecessor of one or more
   * descendants).
   *
   * No D28 dispatch reaction is fired (removal cannot make a node
   * eligible for dispatch).
   */
  async removeNode(args: RemoveNodeArgs): Promise<void> {
    const workflowId = args.workflowId;
    let retryResult: StuckRecoveryOutcome = { inserted: false };

    this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) throw new WorkflowNotFoundError(workflowId);
      if (wf.status !== "running") throw new WorkflowAlreadyTerminalError(workflowId);

      const node = this.repo.readNodeTx(tx, args.nodeId);
      if (node === null) throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
      if (node.workflowId !== workflowId) {
        throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
      }
      if (node.status !== "not_started") {
        throw new WorkflowNodeNotMutableError(workflowId, args.nodeId, node.status, "removeNode");
      }

      // Orphan-child check uses the PRE-delete edge set. Performed
      // BEFORE the row + edge deletes so a rejected call leaves no
      // state behind (the tx would still roll back on throw, but
      // surfacing the rejection earlier keeps the code self-evident
      // and avoids the rare case of a write-then-throw partial
      // application in a future refactor).
      const liveEdges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
      const childIds = liveEdges.filter((e) => e.from === args.nodeId).map((e) => e.to);
      const parentsByChild = new Map<string, string[]>();
      for (const e of liveEdges) {
        if (!parentsByChild.has(e.to)) parentsByChild.set(e.to, []);
        parentsByChild.get(e.to)!.push(e.from);
      }
      for (const child of childIds) {
        const others = (parentsByChild.get(child) ?? []).filter((p) => p !== args.nodeId);
        if (others.length === 0) {
          throw new WorkflowRemoveNodeOrphansChildError(workflowId, args.nodeId, child);
        }
      }

      this.repo.deleteEdgesAdjacentToNodeTx(tx, workflowId, args.nodeId);
      this.repo.deleteNodeTx(tx, args.nodeId);

      // Seed the recompute on every former child — each just lost
      // a parent, so its longest-path phase may have decreased; the
      // not_started descendants of those children may then shift in
      // turn (the helper handles the cascade).
      const phaseDiff = this.recomputePhasesInTx(tx, workflowId, childIds);
      this.repo.updateNodePhases(tx, phaseDiff);

      const nowIso = this.now().toISOString();
      retryResult = this.checkStuckAndRecoverInTx(tx, workflowId, nowIso);
    });

    await this.dispatchRetryIfInserted(retryResult);
    this.nudgeEngine(workflowId);
  }

  // ─── removeEdge ──────────────────────────────────────────

  /**
   * Delete a single edge `(fromNodeId, toNodeId)`. Allowed only when:
   *
   *   - the workflow is `running` and the caller is the unique
   *     running coord (cross-cut auth gate);
   *   - both endpoints belong to this workflow;
   *   - the edge exists ({@link WorkflowEdgeNotFoundError} otherwise);
   *   - the to-node's status is `not_started` (sealing rule);
   *   - the to-node would retain ≥1 parent after the delete
   *     ({@link WorkflowRemoveEdgeOrphansChildError} otherwise).
   *
   * After the delete, the to-node's phase + its not_started
   * descendants' phases are recomputed (the deleted edge may have
   * been the longest-path predecessor).
   *
   * No D28 dispatch reaction is fired (removal cannot make a node
   * eligible for dispatch).
   */
  async removeEdge(args: RemoveEdgeArgs): Promise<void> {
    const workflowId = args.workflowId;
    let retryResult: StuckRecoveryOutcome = { inserted: false };

    this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) throw new WorkflowNotFoundError(workflowId);
      if (wf.status !== "running") throw new WorkflowAlreadyTerminalError(workflowId);

      const endpoints = this.repo.readNodesByIds(tx, [args.fromNodeId, args.toNodeId]);
      const fromNode = endpoints.find((n) => n.id === args.fromNodeId);
      const toNode = endpoints.find((n) => n.id === args.toNodeId);
      if (fromNode === undefined) throw new WorkflowNodeNotFoundError(workflowId, args.fromNodeId);
      if (toNode === undefined) throw new WorkflowNodeNotFoundError(workflowId, args.toNodeId);

      if (fromNode.workflowId !== workflowId) {
        throw new WorkflowNodeNotFoundError(workflowId, fromNode.id);
      }
      if (toNode.workflowId !== workflowId) {
        throw new WorkflowNodeNotFoundError(workflowId, toNode.id);
      }

      if (toNode.status !== "not_started") {
        throw new WorkflowNodeNotMutableError(
          workflowId,
          args.toNodeId,
          toNode.status,
          "removeEdge",
        );
      }

      const liveEdges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
      const exists = liveEdges.some((e) => e.from === args.fromNodeId && e.to === args.toNodeId);
      if (!exists) {
        throw new WorkflowEdgeNotFoundError(workflowId, args.fromNodeId, args.toNodeId);
      }

      const parentsOfTo = liveEdges.filter((e) => e.to === args.toNodeId).map((e) => e.from);
      if (parentsOfTo.length <= 1) {
        throw new WorkflowRemoveEdgeOrphansChildError(workflowId, args.fromNodeId, args.toNodeId);
      }

      const deleted = this.repo.deleteEdgeTx(tx, {
        workflowId,
        from: args.fromNodeId,
        to: args.toNodeId,
      });
      // Defensive: the row was present per the `exists` check above;
      // a 0-rows delete here would indicate a concurrent mutation,
      // which the auth gate + tx isolation already preclude.
      void deleted;

      const phaseDiff = this.recomputePhasesInTx(tx, workflowId, [args.toNodeId]);
      this.repo.updateNodePhases(tx, phaseDiff);

      const nowIso = this.now().toISOString();
      retryResult = this.checkStuckAndRecoverInTx(tx, workflowId, nowIso);
    });

    await this.dispatchRetryIfInserted(retryResult);

    // TODO(phase-3-dispatch): no nodes become dispatchable from a
    // pure edge removal; left as a comment for symmetry with the
    // other structural primitives.
    this.nudgeEngine(workflowId);
  }

  // ─── replaceNodeSpec ─────────────────────────────────────

  /**
   * Replace a node's opaque `spec` payload. Kind cannot change —
   * there is no `newKind` arg, and the substrate routes the
   * re-validation through the existing-kind's runner.
   *
   * Allowed only when:
   *
   *   - the workflow is `running` and the caller is the unique
   *     running coord (cross-cut auth gate);
   *   - the target node belongs to this workflow;
   *   - the target node's status is `not_started`;
   *   - `runner.validate(newSpec, ctx)` accepts the payload.
   *
   * Spec doesn't affect topology, so no phase recompute fires.
   *
   * Denorm sync: if the target node is the latest coord-kind node
   * in this workflow (`ORDER BY created_at DESC, id DESC LIMIT 1`),
   * `workflows.coordinator_agent` is refreshed from the new spec's
   * `agent` field. Otherwise the denorm is left untouched — older
   * coord nodes don't drive the denorm because the substrate already
   * stamped the denorm from the latest coord at its insert time.
   */
  async replaceNodeSpec(args: ReplaceNodeSpecArgs): Promise<void> {
    const workflowId = args.workflowId;

    // Lifecycle gate. The returned entity carries the denormalized
    // `coordinatorAgent` we thread into the validate ctx so the worker
    // runner can enforce W3 (menu-membership) without an extra read.
    const wfRow = await this.assertWorkflowRunning(workflowId);

    // Phase A: pre-validate outside the tx so the runner's potentially
    // async validate runs without holding a write lock. Errors that
    // depend on persisted state (status, workflow-membership) are
    // re-checked inside the tx below — the Phase A read is best-effort
    // ergonomics, the inside-tx check is the source of truth.
    const phaseANode = await this.repo.readNode(args.nodeId);
    if (phaseANode === null) throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
    if (phaseANode.workflowId !== workflowId) {
      throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
    }
    if (phaseANode.status !== "not_started") {
      throw new WorkflowNodeNotMutableError(
        workflowId,
        args.nodeId,
        phaseANode.status,
        "replaceNodeSpec",
      );
    }

    const nodeKind = phaseANode.kind;
    const runner = this.runnerFor(nodeKind);
    const validateCtx: WorkflowNodeValidateCtx = {
      workflowId,
      workflowStatus: "running",
      coordinatorAgent: wfRow.coordinatorAgent,
    };
    const validatedSpec = await runner.validate(args.newSpec, validateCtx);

    if (nodeKind === COORDINATOR_KIND) {
      // The substrate needs `spec.agent` to maintain the
      // `workflows.coordinator_agent` denorm. Surface a clear error
      // if the runner returned a shape without it (mirrors the same
      // assertion in `createWorkflow` and `addNode`).
      assertCoordinatorSpecAgent(validatedSpec);
    }

    let retryResult: StuckRecoveryOutcome = { inserted: false };
    this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) throw new WorkflowNotFoundError(workflowId);
      if (wf.status !== "running") throw new WorkflowAlreadyTerminalError(workflowId);

      // Re-read inside the tx so a concurrent dispatch / cancel that
      // moved the node out of `not_started` rejects this write
      // instead of silently overwriting a sealed row.
      const node = this.repo.readNodeTx(tx, args.nodeId);
      if (node === null) throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
      if (node.workflowId !== workflowId) {
        throw new WorkflowNodeNotFoundError(workflowId, args.nodeId);
      }
      if (node.status !== "not_started") {
        throw new WorkflowNodeNotMutableError(
          workflowId,
          args.nodeId,
          node.status,
          "replaceNodeSpec",
        );
      }
      // The substrate's view of `kind` comes from the `kind` column,
      // not from spec_json. Even if a future runner returned a spec
      // with a `kind` field, the substrate ignores it on read — the
      // immutable-kind contract is enforced by the absence of a
      // `newKind` arg AND by `kind` being persisted in its own
      // column.
      if (node.kind !== nodeKind) {
        throw new WorkflowError(
          `replaceNodeSpec: kind changed between Phase A read and tx (${nodeKind} → ${node.kind}); concurrent schema mutation?`,
        );
      }

      this.repo.updateNodeSpecTx(tx, args.nodeId, validatedSpec);

      if (nodeKind === COORDINATOR_KIND) {
        const latestCoordId = this.repo.findLatestCoordIdTx(tx, workflowId);
        if (latestCoordId === args.nodeId) {
          const agent = (validatedSpec as { agent: string }).agent;
          this.repo.updateWorkflowCoordinatorAgentTx(tx, workflowId, agent);
        }
      }

      const nowIso = this.now().toISOString();
      retryResult = this.checkStuckAndRecoverInTx(tx, workflowId, nowIso);
    });
    await this.dispatchRetryIfInserted(retryResult);
    this.nudgeEngine(workflowId);
  }

  // ─── addSubgraph ─────────────────────────────────────────

  /**
   * Batch insert of N nodes + M edges in one write tx.
   *
   * Each declared `node` carries a `tempId` (batch-local primary
   * key) and an optional `existingParents` array (real node ids
   * already persisted in this workflow). Each `edge` references its
   * endpoints via a {@link NodeRef} discriminated union (either an
   * `existing` real id or a `temp` tempId). The substrate resolves
   * all tempIds to real UUIDv4 node ids, computes phases by
   * topological walk, and inserts everything inside one tx.
   *
   * Per-temp acceptance gates (all enforced before the write tx
   * opens; see implementation for the layered ordering):
   *
   *   1. Auth: derived caller coord (workflow `running`).
   *   2. nodes.length ≥ 1.
   *   3. tempId uniqueness + non-empty.
   *   4. Every temp has ≥1 parent (existing + intra-batch).
   *   5. Every NodeRef resolves (temp → declared tempId;
   *      existing → real node in this workflow).
   *   6. Existing targets of new edges are `not_started`.
   *   7. Intra-batch + joined-DAG acyclic.
   *   8. Worker temps reject failed/cancelled parents (D29).
   *   9. ≤1 coord-kind temp in batch.
   *  10. If any coord temp present: D23 (caller has no other
   *      coord-kind child) AND D27 (coord temp's existingParents
   *      includes the caller).
   *  11. Per-temp `runner.validate(spec, ctx)`.
   *
   * The joined-DAG cycle check (#7) re-uses the per-edge
   * {@link wouldCreateCycle} helper applied to the accumulating
   * edge set; this is the simpler-to-audit alternative to a
   * full-graph SCC scan and is correct because the substrate's pre-
   * batch edge set is already acyclic (invariant of every prior
   * mutation).
   *
   * Returns the mapping `tempId → { nodeId, phase }` for every
   * inserted node. Phases match the persisted row exactly (the
   * helper reads back from the diff that was just written).
   *
   * D28 eager-dispatch reaction is NOT fired in Phase 2b; the
   * runtime substrate will pick it up in a later phase.
   */
  async addSubgraph(args: AddSubgraphArgs): Promise<AddSubgraphResult> {
    if (args.nodes.length === 0) throw new WorkflowSubgraphEmptyError();

    const workflowId = args.workflowId;

    // Normalize the raw input into the pure-helper shape, then dedupe
    // (P15-a). Callers may pass the same `existingParents` ref twice
    // or declare an `edges[]` entry twice; the substrate silently
    // collapses both because they're semantically idempotent (and
    // would otherwise trip the composite-PK constraint at insert
    // time as a generic SQLite error rather than a domain rejection).
    // Downstream topology + insert logic always sees the deduplicated
    // form. Mirrors `addNode`'s `Array.from(new Set(args.parents))`
    // convention.
    const rawTempNodes: SubgraphTempNodeShape[] = args.nodes.map((n) => ({
      tempId: n.tempId,
      kind: n.kind,
      existingParents: n.existingParents ?? [],
    }));
    const rawTempEdges: SubgraphEdgeShape[] = args.edges.map((e) => ({ from: e.from, to: e.to }));
    const { nodes: tempNodes, edges: tempEdges } = normalizeSubgraphInput({
      nodes: rawTempNodes,
      edges: rawTempEdges,
    });

    // Pure-helper validation (steps 2, 3, 4, 9 + intra-batch ref
    // resolution part of 5). Throws on first violation.
    validateSubgraphShape(workflowId, tempNodes, tempEdges);

    // Topological order over the temps (intra-batch acyclicity part
    // of #7). Deterministic across runs — lexicographic tiebreaker
    // on tempId so the inserted-nodes return order is stable.
    const topoOrder = resolveSubgraphTopology(workflowId, tempNodes, tempEdges);

    // Lifecycle gate: workflow must exist and be running. The
    // returned entity carries the denormalized `coordinatorAgent`
    // we thread into every validate ctx in the topo loop so the
    // worker runner can enforce W3 (menu-membership) once per node
    // without re-reading the workflow row per iteration.
    const wfRow = await this.assertWorkflowRunning(workflowId);

    // Pass A (P15-c): cheap existing-ref existence + workflow-membership
    // pre-check. Runs BEFORE the per-temp `runner.validate` calls so
    // a malformed batch with a typo'd ref short-circuits without
    // paying N validate calls. Mirrors the inside-tx recheck below
    // exactly (same error types, same predicates) so a caller cannot
    // observe a different rejection depending on which pass caught
    // the issue. The joined-DAG cycle check stays inside the write
    // tx — it needs snapshot consistency that a pre-tx read cannot
    // provide.
    const existingRefIds = new Set<string>();
    for (const t of tempNodes) {
      for (const p of t.existingParents) existingRefIds.add(p);
    }
    for (const e of tempEdges) {
      if (e.from.kind === "existing") existingRefIds.add(e.from.id);
      if (e.to.kind === "existing") existingRefIds.add(e.to.id);
    }
    if (existingRefIds.size > 0) {
      const refIdList = Array.from(existingRefIds);
      const preReadNodes = this.repo.readNodesByIds(this.db, refIdList);
      const preReadById = new Map(preReadNodes.map((n) => [n.id, n]));
      for (const refId of refIdList) {
        const node = preReadById.get(refId);
        if (node === undefined) {
          throw new WorkflowSubgraphNodeRefUnresolvedError(workflowId, "existing", refId);
        }
        if (node.workflowId !== workflowId) {
          throw new WorkflowSubgraphNodeRefUnresolvedError(workflowId, "existing", refId);
        }
      }
    }

    // Substrate-internal index lookups built once per batch.
    const tempByTempId = new Map<string, SubgraphTempNodeShape>();
    for (const t of tempNodes) tempByTempId.set(t.tempId, t);
    const fullNodeByTempId = new Map<string, AddSubgraphNodeInput>();
    for (const n of args.nodes) fullNodeByTempId.set(n.tempId, n);

    // Allocate real node ids before per-temp validate so the
    // validate ctx is constant across the batch (validate args
    // themselves DO NOT carry the tempId-to-realId mapping — that's
    // a substrate concern). Stable order = topological order.
    const tempIdToNodeId = new Map<string, string>();
    for (const t of topoOrder) {
      tempIdToNodeId.set(t.tempId, generateWorkflowNodeId(this.randomUUID));
    }

    // Per-temp spec validation. Runs OUTSIDE the write tx (runner
    // validate may do catalog lookups). Validate order matches the
    // topological order so a runner that builds incremental context
    // sees parents before children.
    const validatedSpecByTempId = new Map<string, unknown>();
    for (const t of topoOrder) {
      const full = fullNodeByTempId.get(t.tempId);
      if (full === undefined) {
        throw new WorkflowError(`addSubgraph: lost full node entry for tempId "${t.tempId}"`);
      }
      const runner = this.runnerFor(t.kind);
      const validateCtx: WorkflowNodeValidateCtx = {
        workflowId,
        workflowStatus: "running",
        coordinatorAgent: wfRow.coordinatorAgent,
      };
      const validatedSpec = await runner.validate(full.spec, validateCtx);
      if (t.kind === COORDINATOR_KIND) assertCoordinatorSpecAgent(validatedSpec);
      validatedSpecByTempId.set(t.tempId, validatedSpec);
    }

    const nowIso = this.now().toISOString();
    const insertedNodes: AddSubgraphInsertedNode[] = [];
    let retryResult: StuckRecoveryOutcome = { inserted: false };

    this.db.transaction((tx) => {
      const wf = this.repo.readWorkflowTx(tx, workflowId);
      if (wf === null) throw new WorkflowNotFoundError(workflowId);
      if (wf.status !== "running") throw new WorkflowAlreadyTerminalError(workflowId);

      // Resolve every existing-ref against the live DB state. One
      // pass collects all referenced existing ids, then a single
      // batch read populates the index.
      const existingRefIds = new Set<string>();
      for (const t of tempNodes) {
        for (const p of t.existingParents) existingRefIds.add(p);
      }
      for (const e of tempEdges) {
        if (e.from.kind === "existing") existingRefIds.add(e.from.id);
        if (e.to.kind === "existing") existingRefIds.add(e.to.id);
      }
      const existingNodes = this.repo.readNodesByIds(tx, Array.from(existingRefIds));
      const existingById = new Map(existingNodes.map((n) => [n.id, n]));
      for (const refId of existingRefIds) {
        const node = existingById.get(refId);
        if (node === undefined) {
          throw new WorkflowSubgraphNodeRefUnresolvedError(workflowId, "existing", refId);
        }
        if (node.workflowId !== workflowId) {
          throw new WorkflowSubgraphNodeRefUnresolvedError(workflowId, "existing", refId);
        }
      }

      // Existing targets of new edges must be `not_started` (D24 — a
      // node that's already dispatched cannot accept new incoming
      // edges without violating the sealing rule).
      for (const e of tempEdges) {
        if (e.to.kind === "existing") {
          const target = existingById.get(e.to.id);
          if (target !== undefined && target.status !== "not_started") {
            throw new WorkflowNodeNotMutableError(
              workflowId,
              e.to.id,
              target.status,
              "addSubgraph",
            );
          }
        }
      }

      // Per-temp parent state + kind-specific gates.
      // Worker temps reject failed/cancelled parents. Coord temps
      // must descend structurally from a coord-kind parent (orphan
      // rule); each coord predecessor must not already have a coord
      // child (single-successor rule). The intra-batch ≤1 coord temp
      // rule is enforced by validateSubgraphShape.
      const coordTemp = tempNodes.find((t) => t.kind === COORDINATOR_KIND);
      for (const t of tempNodes) {
        if (t.kind === WORKER_KIND) {
          for (const pid of t.existingParents) {
            const parent = existingById.get(pid);
            if (parent !== undefined) {
              if (parent.status === "failed" || parent.status === "cancelled") {
                throw new ParentStateError(workflowId, t.kind, parent.id, parent.status);
              }
            }
          }
        }
      }
      if (coordTemp !== undefined) {
        const coordExistingParents = coordTemp.existingParents
          .map((pid) => existingById.get(pid))
          .filter((p): p is WorkflowNodeEntity => p !== undefined && p.kind === COORDINATOR_KIND);
        if (coordExistingParents.length === 0) {
          throw new OrphanCoordInsertError(workflowId);
        }
        const liveEdges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
        for (const coordParent of coordExistingParents) {
          const childIds = liveEdges.filter((e) => e.from === coordParent.id).map((e) => e.to);
          if (childIds.length === 0) continue;
          const childNodes = this.repo.readNodesByIds(tx, childIds);
          if (childNodes.some((c) => c.kind === COORDINATOR_KIND)) {
            throw new MultipleSuccessorCoordsError(workflowId, coordParent.id);
          }
        }
      }

      // Joined-DAG acyclicity (#7 — joined part). Accumulate edges
      // onto the live edge set; reject the first new edge that would
      // close a cycle. Equivalent to a full graph re-check at lower
      // cost; correct because the pre-batch DAG is acyclic by
      // invariant.
      const accumulatedEdges: { from: string; to: string }[] = this.repo
        .listEdgesByWorkflowTx(tx, workflowId)
        .map((e) => ({ from: e.from, to: e.to }));
      // Project tempEdges into real-id pairs using the tempId→nodeId
      // mapping (we resolve real ids here BEFORE inserting rows so
      // the cycle check sees the final id space; insertion order is
      // governed by the topo sort below).
      type ResolvedEdge = {
        readonly from: string;
        readonly to: string;
        readonly origFrom: string;
        readonly origTo: string;
      };
      const projectedEdges: ResolvedEdge[] = tempEdges.map((e) => {
        const from = e.from.kind === "existing" ? e.from.id : tempIdToNodeId.get(e.from.tempId)!;
        const to = e.to.kind === "existing" ? e.to.id : tempIdToNodeId.get(e.to.tempId)!;
        return {
          from,
          to,
          origFrom: e.from.kind === "existing" ? e.from.id : `temp:${e.from.tempId}`,
          origTo: e.to.kind === "existing" ? e.to.id : `temp:${e.to.tempId}`,
        };
      });
      // Also include synthetic parent→temp edges (existingParents),
      // since they participate in the joined DAG as well.
      const allNewEdges: ResolvedEdge[] = [];
      for (const t of tempNodes) {
        const realChild = tempIdToNodeId.get(t.tempId)!;
        for (const parentId of t.existingParents) {
          allNewEdges.push({
            from: parentId,
            to: realChild,
            origFrom: parentId,
            origTo: `temp:${t.tempId}`,
          });
        }
      }
      for (const e of projectedEdges) allNewEdges.push(e);
      for (const ne of allNewEdges) {
        if (wouldCreateCycle(accumulatedEdges, ne)) {
          throw new WorkflowSubgraphCyclicError(workflowId, ne.origFrom, ne.origTo);
        }
        accumulatedEdges.push({ from: ne.from, to: ne.to });
      }

      // Compute per-temp phase. Existing parents contribute their
      // persisted phase; intra-batch temp parents contribute their
      // freshly-assigned phase from earlier in the topo pass.
      const tempPhaseByTempId = new Map<string, number>();
      for (const t of topoOrder) {
        let maxParent = -1;
        for (const pid of t.existingParents) {
          const p = existingById.get(pid);
          if (p !== undefined && p.phase > maxParent) maxParent = p.phase;
        }
        for (const e of tempEdges) {
          if (e.to.kind === "temp" && e.to.tempId === t.tempId) {
            if (e.from.kind === "existing") {
              const p = existingById.get(e.from.id);
              if (p !== undefined && p.phase > maxParent) maxParent = p.phase;
            } else {
              const ph = tempPhaseByTempId.get(e.from.tempId);
              if (ph !== undefined && ph > maxParent) maxParent = ph;
            }
          }
        }
        tempPhaseByTempId.set(t.tempId, maxParent + 1);
      }

      // Insert rows in topological order. Coord-kind temps go through
      // the same denorm-update path as `addNode(kind='coordinator')`
      // via inline writes — we re-build the same shape inline rather
      // than reuse `insertCoordNodeInTx` so the explicit per-temp
      // phase from the topo pass is honored (the helper would
      // recompute from parents-on-disk, which doesn't yet include
      // sibling temps).
      const latestCoordTempId: string | null = coordTemp?.tempId ?? null;
      for (const t of topoOrder) {
        const nodeId = tempIdToNodeId.get(t.tempId)!;
        const phase = tempPhaseByTempId.get(t.tempId)!;
        const validatedSpec = validatedSpecByTempId.get(t.tempId);
        const node = nodeEntityFor({
          id: nodeId,
          workflowId,
          kind: t.kind,
          spec: validatedSpec,
          phase,
          status: "not_started",
          nowIso,
        });
        this.repo.insertNode(tx, node);
        insertedNodes.push({ tempId: t.tempId, nodeId, phase });
      }
      // Insert edges: existingParent → temp, then explicit batch edges.
      for (const t of topoOrder) {
        const realChild = tempIdToNodeId.get(t.tempId)!;
        for (const parentId of t.existingParents) {
          this.repo.insertEdge(tx, { workflowId, from: parentId, to: realChild });
        }
      }
      for (const e of tempEdges) {
        const from = e.from.kind === "existing" ? e.from.id : tempIdToNodeId.get(e.from.tempId)!;
        const to = e.to.kind === "existing" ? e.to.id : tempIdToNodeId.get(e.to.tempId)!;
        this.repo.insertEdge(tx, { workflowId, from, to });
      }

      // Denorm sync if the batch carries a coord temp — by the
      // batch's own ordering, that coord is the latest coord in this
      // workflow at commit time. The `findLatestCoordIdTx`-guarded
      // write (P15-f) unifies the addSubgraph denorm sync with the
      // sibling pattern in `replaceNodeSpec`: both consult the same
      // helper for "is this row the latest coord?" so the substrate
      // has a single source of truth for the (created_at DESC, id
      // DESC) ordering. The equality holds in normal operation
      // (freshly-inserted coord wins on createdAt), but the explicit
      // check defends against any future schema-corruption case the
      // helper is hardened against.
      if (latestCoordTempId !== null) {
        const validatedSpec = validatedSpecByTempId.get(latestCoordTempId) as { agent: string };
        const newCoordNodeId = tempIdToNodeId.get(latestCoordTempId) as string;
        const latestCoordId = this.repo.findLatestCoordIdTx(tx, workflowId);
        if (latestCoordId === newCoordNodeId) {
          this.repo.updateWorkflowCoordinatorAgentTx(tx, workflowId, validatedSpec.agent);
        }
      }

      // Phase recompute on every existing not_started to-node that
      // gained a parent from this batch. A new temp parent can
      // increase the to-node's longest-path depth (subtle correctness
      // trap callout in the spec).
      const existingTargetIds = new Set<string>();
      for (const e of tempEdges) {
        if (e.to.kind === "existing") {
          const target = existingById.get(e.to.id);
          if (target !== undefined && target.status === "not_started") {
            existingTargetIds.add(e.to.id);
          }
        }
      }
      if (existingTargetIds.size > 0) {
        const phaseDiff = this.recomputePhasesInTx(tx, workflowId, Array.from(existingTargetIds));
        this.repo.updateNodePhases(tx, phaseDiff);
      }

      // Commit-time DAG well-formedness invariant. At every quiescent
      // state the workflow's structural leaf frontier must be exactly
      // {1 coordinator}. The substrate's low-level primitives are
      // sequenceable and the detector below recovers from transient
      // multi-leaf states, but `addSubgraph` is the one atomic-batch
      // primitive whose intermediate state is never visible — the
      // batch either commits as a well-formed step or rolls back
      // wholesale. Reject here before the detector ever runs so the
      // operator sees the structural rejection, not a silent retry
      // insertion.
      const finalNodes = this.repo.listNodesByWorkflowTx(tx, workflowId);
      const finalEdges = this.repo.listEdgesByWorkflowTx(tx, workflowId);
      const finalLeaves = structuralLeaves(
        finalNodes,
        finalEdges.map((e) => ({ from: e.from, to: e.to })),
      );
      const invariantOk = finalLeaves.length === 1 && finalLeaves[0]!.kind === COORDINATOR_KIND;
      if (!invariantOk) {
        throw new WorkflowDagInvariantError(
          workflowId,
          finalLeaves.map((n) => n.id),
          finalLeaves.map((n) => n.kind),
        );
      }

      retryResult = this.checkStuckAndRecoverInTx(tx, workflowId, nowIso);
    });

    // TODO(phase-3-dispatch): dispatch reaction over inserted nodes
    // + existing nodes that gained edges. Phase 2b deliberately
    // leaves the eager-dispatch loop unwired here — the existing
    // engine path (addNode / addEdge) handles single-shot inserts
    // already; the batch primitive's reaction belongs in the Phase
    // 3+4 wiring.

    await this.dispatchRetryIfInserted(retryResult);
    this.nudgeEngine(workflowId);
    return { insertedNodes };
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
   *
   * `onTerminal` is threaded into the runner's `dispatch` opts so
   * the runner can push terminal results back to the substrate
   * (where it's handled by {@link markNodeTerminal}) without
   * knowing about service plumbing. When this method is invoked
   * from the legacy eager-dispatch reactions (createWorkflow /
   * addNode / addEdge) without an engine wired, the substrate
   * substitutes a default `onTerminal` that delegates to {@link
   * markNodeTerminal} directly. Either path lands the same
   * idempotent state write — `markNodeTerminal` is the single
   * source of truth for the substrate's terminal write.
   */
  async dispatchAtomic(
    nodeId: string,
    onTerminal?: (result: WorkflowNodeTerminalResult) => void,
  ): Promise<void> {
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

    // Resolve the `onTerminal` callback. Callers that don't supply
    // one (eager-dispatch reactions on the legacy path, or tests
    // that exercise dispatchAtomic directly without an engine) get
    // a default that drives `markNodeTerminal` so the substrate's
    // terminal-write path stays single-source-of-truth.
    const effectiveOnTerminal: (result: WorkflowNodeTerminalResult) => void =
      onTerminal ??
      ((result) => {
        // Default path used when no engine-supplied callback is
        // present (eager-dispatch reactions on the legacy path, or
        // tests that exercise `dispatchAtomic` directly). Fire-and-
        // forget into `markNodeTerminal`, with a `.catch` so a
        // throw from the terminal-write tx surfaces as a logged
        // error instead of an unhandled promise rejection (we hold
        // a synchronous closure boundary here and cannot propagate
        // back into the runner).
        void this.markNodeTerminal(payload.workflowId, payload.nodeId, result).catch((err) => {
          this.logger.error(
            { workflowId: payload.workflowId, nodeId: payload.nodeId, err },
            "dispatchAtomic: default onTerminal markNodeTerminal threw",
          );
        });
      });

    try {
      await payload.runner.dispatch({
        workflowId: payload.workflowId,
        nodeId: payload.nodeId,
        spec: payload.spec,
        nodeDir: payload.nodeDir,
        onTerminal: effectiveOnTerminal,
      });
    } catch (err) {
      this.logger.warn(
        { nodeId, err },
        "dispatchAtomic: runner.dispatch threw; marking node failed",
      );
      const reason = `runner.dispatch threw: ${err instanceof Error ? err.message : String(err)}`;
      try {
        await this.markNodeTerminal(payload.workflowId, payload.nodeId, {
          status: "failed",
          reason,
        });
      } catch (writeErr) {
        this.logger.error(
          { nodeId, err: writeErr },
          "dispatchAtomic: failed to write failed status after dispatch error",
        );
      }
    }
  }

  // ─── markNodeTerminal ────────────────────────────────────

  /**
   * Idempotent terminal-state writer. Called by the engine's
   * `onTerminal` handler when a runner pushes a terminal outcome
   * back to the substrate. Also used as the default `onTerminal`
   * inside {@link dispatchAtomic} when no engine is wired.
   *
   * Idempotency: if the target node is already terminal in the DB
   * at the time of the write, the call is a silent no-op (debug-
   * logged). The substrate considers double-firing benign — runners
   * SHOULD avoid it (one extra tx per duplicate), but cannot violate
   * substrate invariants by doing so.
   *
   * On a successful terminal write the substrate nudges the engine
   * (downstream nodes may have become eligible). The nudge is
   * post-commit and best-effort — a missing engine is a no-op.
   *
   * `cancelled` is a legal terminal coming from the runner (it
   * observed the unit-of-work being cancelled out-of-band, e.g.
   * via a parallel CLI). The substrate accepts it the same way
   * `cancelNode` would.
   */
  async markNodeTerminal(
    workflowId: string,
    nodeId: string,
    result: WorkflowNodeTerminalResult,
  ): Promise<void> {
    const nowIso = this.now().toISOString();
    let didWrite = false;
    let retryResult: StuckRecoveryOutcome = { inserted: false };
    try {
      this.db.transaction((tx) => {
        const node = this.repo.readNodeTx(tx, nodeId);
        if (node === null) {
          this.logger.warn(
            { workflowId, nodeId, result },
            "markNodeTerminal: node not found; ignoring",
          );
          return;
        }
        if (node.workflowId !== workflowId) {
          this.logger.warn(
            {
              workflowId,
              nodeId,
              actualWorkflowId: node.workflowId,
              result,
            },
            "markNodeTerminal: node belongs to a different workflow; ignoring",
          );
          return;
        }
        if (
          node.status === "succeeded" ||
          node.status === "failed" ||
          node.status === "cancelled"
        ) {
          this.logger.debug(
            { workflowId, nodeId, status: node.status, result },
            "markNodeTerminal: node already terminal; idempotent no-op",
          );
          return;
        }
        this.repo.updateNodeLifecycle(tx, {
          id: nodeId,
          status: result.status,
          endedAt: nowIso,
        });
        didWrite = true;
        retryResult = this.checkStuckAndRecoverInTx(tx, workflowId, nowIso);
      });
    } catch (err) {
      this.logger.error({ workflowId, nodeId, result, err }, "markNodeTerminal: write tx threw");
      throw err;
    }
    await this.dispatchRetryIfInserted(retryResult);
    if (didWrite) {
      this.nudgeEngine(workflowId);
    }
  }

  // ─── Internals ───────────────────────────────────────────

  /**
   * Lifecycle gate read used outside the write tx — confirms the
   * workflow exists and is running before launching potentially
   * expensive `runner.validate` calls. The mutation tx re-checks the
   * same predicates atomically before persisting.
   *
   * Returns the loaded {@link WorkflowEntity} so callers that need to
   * populate {@link WorkflowNodeValidateCtx} fields denormalized from
   * the workflow row (e.g. `coordinatorAgent` for the W3
   * worker-runner capability check) can reuse the same read without
   * issuing a second `readWorkflow` round-trip.
   */
  private async assertWorkflowRunning(workflowId: string): Promise<WorkflowEntity> {
    const wf = await this.repo.readWorkflow(workflowId);
    if (wf === null) throw new WorkflowNotFoundError(workflowId);
    if (wf.status !== "running") throw new WorkflowAlreadyTerminalError(workflowId);
    return wf;
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
   * Insert a retry coordinator-kind node by directly composing
   * repository writes. Skips `runner.validate` — the spec is just
   * `{ agent }` copied from the previous coord, which was validated
   * when that coord was originally inserted (re-validating inside the
   * detector's tx would require an async call from within a write
   * lock, and the spec has not been mutated).
   *
   * The `parentIds` list is built by the detector and MUST include
   * the prev-coord id (i.e. `prevCoord.id` is always present) so the
   * generic `OrphanCoordInsertError` invariant is satisfied even in
   * the `workers_finished_without_coord` case where the structural
   * leaves are all workers. The caller deduplicates while preserving
   * insertion order; the helper trusts that contract.
   *
   * Mirrors {@link insertCoordNodeInTx} for the denorm-update path:
   * the new coord becomes the workflow's latest coord, so its agent
   * replaces `workflows.coordinator_agent` in the same tx.
   *
   * Returns the inserted node id + phase so the caller can wire up
   * post-commit eager-dispatch.
   */
  private insertCoordRetryNodeInTx(
    tx: Db,
    args: {
      readonly workflowId: string;
      readonly parentIds: ReadonlyArray<string>;
      readonly agent: string;
      readonly retry: NodeRetryMetadata;
      readonly nowIso: string;
    },
  ): { readonly nodeId: string; readonly phase: number } {
    const nodeId = generateWorkflowNodeId(this.randomUUID);
    const parentEntities = this.repo.readNodesByIds(tx, args.parentIds);
    const phase = computePhaseFromParents(parentEntities);
    const spec: { readonly agent: string } = { agent: args.agent };
    const metadata: Readonly<Record<string, unknown>> = { retry: args.retry };
    const node = nodeEntityFor({
      id: nodeId,
      workflowId: args.workflowId,
      kind: COORDINATOR_KIND,
      spec,
      phase,
      status: "not_started",
      metadata,
      nowIso: args.nowIso,
    });
    this.repo.insertNode(tx, node);
    for (const p of args.parentIds) {
      this.repo.insertEdge(tx, { workflowId: args.workflowId, from: p, to: nodeId });
    }
    tx.update(workflows)
      .set({ coordinatorAgent: args.agent })
      .where(eq(workflows.id, args.workflowId))
      .run();
    return { nodeId, phase };
  }

  /**
   * Substrate-internal stuck-coord detector. Runs at the END of
   * every mutation tx body (after the primary writes, before commit)
   * for the eight structural primitives — see the per-primitive call
   * sites for the contract.
   *
   * Conditions for retry insertion (all must hold):
   *
   *   1. The workflow header is still `running` (terminal headers
   *      from a concurrent `finishWorkflow` / `cancelWorkflow` race
   *      cleanly: the post-commit nudge becomes a no-op because the
   *      detector already returned `inserted: false`).
   *   2. Every node in the workflow is in a terminal status
   *      (`succeeded` / `failed` / `cancelled`). `not_started`,
   *      `ready`, and `running` all indicate live work and abort the
   *      detector — `ready` is explicitly non-terminal even though
   *      the engine sometimes uses it as a stepping-stone before
   *      `running`.
   *   3. The structural leaves of the workflow classify as one of
   *      the two reasons (see {@link classifyStuckReason}). Any
   *      mixed leaf set (coord + workers, or unknown) is a no-op —
   *      a coord leaf at the frontier means the workflow still has
   *      a driver and recovery would be redundant.
   *   4. A most-recent terminal coord exists (the `of` pointer for
   *      the retry's `metadata.retry`). For a workflow with at
   *      least one terminal coord this always holds — by I4 a stuck
   *      workflow has run at least the initial coord which has
   *      since terminated.
   *
   * Concurrency: SQLite serializes writes, so a second tx attempting
   * to insert a retry would observe the just-inserted not_started
   * retry leaf and fail the "all terminal" check, returning
   * `inserted: false`. No second retry is possible until the inserted
   * one terminates.
   *
   * Returns the structured outcome rather than a bare boolean so the
   * caller can dispatch the freshly inserted coord post-commit and
   * surface the retry id to operator logs.
   */
  private checkStuckAndRecoverInTx(
    tx: Db,
    workflowId: string,
    nowIso: string,
  ): StuckRecoveryOutcome {
    const wf = this.repo.readWorkflowTx(tx, workflowId);
    if (wf === null || wf.status !== "running") return { inserted: false };

    const allNodes = this.repo.listNodesByWorkflowTx(tx, workflowId);
    if (allNodes.length === 0) return { inserted: false };
    for (const n of allNodes) {
      if (n.status === "not_started" || n.status === "ready" || n.status === "running") {
        return { inserted: false };
      }
    }

    const leaves = this.repo.listLeavesInTx(tx, workflowId);
    const reason = classifyStuckReason(leaves);
    if (reason === undefined) return { inserted: false };

    const prevCoord = this.repo.findMostRecentCoordTerminalInTx(tx, workflowId);
    if (prevCoord === null) return { inserted: false };

    const prevAgent = (prevCoord.spec as { readonly agent?: unknown })?.agent;
    if (typeof prevAgent !== "string" || prevAgent.length === 0) {
      throw new WorkflowError(
        `stuck-coord recovery: workflow "${workflowId}" prev coord "${prevCoord.id}" has no agent on spec`,
      );
    }

    const prevRetry = extractNodeRetryMetadata(prevCoord.metadata);
    const attempt = (prevRetry?.attempt ?? 0) + 1;

    // Safety net: cap consecutive retry-coord chains. A well-behaved
    // coord reads `metadata.retry` on wake and either makes forward
    // progress (calls `add-subgraph` or `finish`) or fails the
    // workflow; a coord that keeps exiting without action up to the
    // cap is either buggy or running an agent that doesn't honor the
    // retry contract. Once the cap trips we cannot leave the
    // workflow `running` forever — that would silently consume a
    // dispatch slot with no operator-visible failure. The detector
    // transitions the workflow to `failed` with a structured
    // {@link WorkflowFailure} (`kind: 'substrate'`, `reason:
    // STUCK_RETRY_LIMIT`) inside this same tx so the terminal flip
    // is atomic with the triggering mutation; the post-commit
    // dispatch is a no-op (`inserted: false`).
    //
    // The cap is intentionally low — five gives a real coord enough
    // headroom to recover from a transient validation error or
    // missed inbox event but stops well before any operator-visible
    // resource pressure shows up.
    if (attempt > STUCK_RETRY_MAX_ATTEMPTS) {
      const failure: WorkflowFailure = {
        kind: "substrate",
        reason: STUCK_RETRY_LIMIT,
        message: `stuck-coord recovery cap (${STUCK_RETRY_LIMIT}): exceeded ${STUCK_RETRY_MAX_ATTEMPTS} consecutive retry attempts without forward progress`,
      };
      const flipped = this.repo.casUpdateWorkflowStatus(tx, {
        id: workflowId,
        fromStatus: "running",
        toStatus: "failed",
        endedAt: nowIso,
        failureJson: JSON.stringify(failure),
      });
      this.logger.warn(
        { workflowId, prevCoordId: prevCoord.id, attempt, reason, flipped },
        "stuck-coord recovery: retry attempt cap reached; transitioning workflow to failed",
      );
      return { inserted: false };
    }

    const seen = new Set<string>();
    const parentIds: string[] = [];
    for (const id of [prevCoord.id, ...leaves.map((n) => n.id)]) {
      if (seen.has(id)) continue;
      seen.add(id);
      parentIds.push(id);
    }

    const retry: NodeRetryMetadata = { of: prevCoord.id, reason, attempt };
    const { nodeId: retryNodeId } = this.insertCoordRetryNodeInTx(tx, {
      workflowId,
      parentIds,
      agent: prevAgent,
      retry,
      nowIso,
    });
    this.logger.info(
      { workflowId, retryNodeId, reason, attempt, ofCoord: prevCoord.id },
      "stuck-coord recovery: inserted retry coord",
    );
    return { inserted: true, retryNodeId, reason, attempt };
  }

  /**
   * Helper for the eight mutation primitives: after their tx commits,
   * dispatch the retry coord (if one was inserted by the detector).
   * Wrapped as a method so the call sites can stay one-liners and the
   * compiler's narrowing-across-closures quirk for mutable union
   * variables is sidestepped by a fresh parameter binding.
   */
  private async dispatchRetryIfInserted(outcome: StuckRecoveryOutcome): Promise<void> {
    if (!outcome.inserted) return;
    await this.dispatchAtomic(outcome.retryNodeId);
  }

  /**
   * Recompute phase across the `not_started` subtree rooted at one
   * or more seed nodes. Skips running / terminal descendants —
   * their phase is sealed for the lifetime of the workflow because
   * the dispatch loop has already engaged.
   *
   * Multi-seed because the structural mutations differ in their
   * seed cardinality:
   *   - `addEdge`: 1 seed (the to-node).
   *   - `removeEdge`: 1 seed (the to-node, which just lost a parent).
   *   - `removeNode`: N seeds (every child of the removed node,
   *     since each lost a parent).
   *   - `addSubgraph`: M seeds (each existing not_started to-node
   *     that gained a temp parent).
   *
   * Returns the diff (id → new phase) so the caller can issue the
   * bulk UPDATE inside the same tx.
   */
  private recomputePhasesInTx(
    tx: Db,
    workflowId: string,
    startNodeIds: readonly string[],
  ): Map<string, number> {
    if (startNodeIds.length === 0) return new Map();
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

    // Seed the in-scope set from each not_started start node, then
    // BFS down through not_started descendants.
    const inScope = new Set<string>();
    const queue: string[] = [];
    for (const seedId of startNodeIds) {
      const seed = byId.get(seedId);
      if (seed === undefined || seed.status !== "not_started") continue;
      if (inScope.has(seedId)) continue;
      inScope.add(seedId);
      queue.push(seedId);
    }
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
   * When `excludeRunningCoords` is true (the `finishWorkflow` path),
   * coordinator-kind nodes that are currently `running` are left
   * alone — the calling coord task is allowed to finish its in-flight
   * call frame naturally without the substrate cancelling the very
   * task that is sitting inside `finishWorkflow`.
   */
  private async reconcileCancel(
    workflowId: string,
    opts: { readonly excludeRunningCoords: boolean },
  ): Promise<void> {
    const nodes = await this.repo.listNodesByWorkflow(workflowId);
    const targets = nodes.filter((n) => {
      if (n.status !== "not_started" && n.status !== "ready" && n.status !== "running") {
        return false;
      }
      if (opts.excludeRunningCoords && n.kind === COORDINATOR_KIND && n.status === "running") {
        return false;
      }
      return true;
    });
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

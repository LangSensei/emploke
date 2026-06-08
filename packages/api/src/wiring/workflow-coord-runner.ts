/**
 * `makeWorkflowStubCoordRunner` — the coordinator-kind {@link
 * WorkflowNodeRunner} that drives a deterministic two-step
 * coordinator plan with no LLM, no catalog lookup, and no external
 * unit-of-work.
 *
 * Behavior, by step (derived from the workflow DAG via
 * `service.getDag(workflowId)`):
 *
 *   - `coordCount === 1` (the calling coord is the only coord in the
 *     DAG): treat as the initial coord. Add one worker child + one
 *     follow-up coord child (whose parents are `[self, worker]`),
 *     then fire `onTerminal({status:'succeeded'})`.
 *   - `coordCount === 2` (the calling coord is the second coord —
 *     the follow-up): inspect the non-coord parent's status in the
 *     DAG snapshot and call `service.finishWorkflow` with the
 *     matching outcome. Worker `'succeeded'` maps to outcome
 *     `'succeeded'`; worker `'failed'` or `'cancelled'` maps to
 *     outcome `'failed'` (per `workflow-service.ts:825` —
 *     `finishWorkflow` accepts only `'succeeded' | 'failed'`).
 *     Then fire `onTerminal({status:'succeeded'})`.
 *   - any other count: defensive branch — log at `error` and fire
 *     `onTerminal({status:'failed', reason: ...})`. The substrate's
 *     `MultipleSuccessorCoordsError` (see `errors.ts:180`)
 *     prevents this case in practice, but the runner stays loud if
 *     the invariant breaks.
 *
 * `validate(spec, _ctx)` enforces the persisted-spec shape
 * `{ agent: string }` strictly — extra keys, non-strings, and empty
 * agents are rejected via `WorkflowNodeSpecError("coordinator",
 * detail)` (see `errors.ts:159`). The shape mirrors the bootstrap
 * insert at `workflow-service.ts:438`, so a coord row inserted by
 * `createWorkflow` round-trips through this validator unchanged.
 *
 * `hasInFlightForNode` always returns `false`: this runner is
 * synchronous (no setInterval, no Promise that outlives `dispatch`).
 * Engine-restart recovery that scans `running` rows with
 * `hasInFlightForNode === false` is the correct contract — a stub
 * coord that disappeared mid-run is safe to roll back to `ready`.
 *
 * `cancel(nodeId)` is a no-op for the same reason.
 *
 * # Two-phase init
 *
 * The factory takes `getService: () => WorkflowService` rather than
 * an eager `service: WorkflowService` because the runner is an input
 * to `composeWorkflowModule(...)` and the service is its output —
 * the wiring caller resolves the cycle by assigning the returned
 * service into a closure variable the thunk reads on demand. Mirrors
 * the engine ↔ service two-phase init at `compose.ts:113`.
 */

import {
  type WorkflowNodeRunner,
  WorkflowNodeSpecError,
  type WorkflowNodeTerminalResult,
  type WorkflowNodeValidateCtx,
  type WorkflowService,
} from "@emploke/workflow";
import pino, { type Logger } from "pino";

const silentLogger: Logger = pino({ level: "silent" });

/**
 * The worker agent FQN the stub coord dispatches. Production catalog
 * MUST have this agent registered when this runner is wired in; the
 * worker runner's `validate` at `workflow-task-runner.ts:182` enforces
 * non-empty string agent and (in production) catalog existence.
 */
export const WORKFLOW_STUB_WORKER_AGENT = "emploke/echo-worker";

/**
 * The worker brief the stub coord dispatches. Fixed string — the
 * workflow's user-supplied `brief` is NOT threaded through. The worker
 * spec validator at `workflow-task-runner.ts:185-194` requires the
 * brief be a non-empty single-line string ≤200 chars; this constant
 * satisfies all three.
 */
export const WORKFLOW_STUB_WORKER_BRIEF = "stub coord smoke worker";

/**
 * Persisted spec shape for every coord node created by this runner
 * (initial + follow-up). Matches the substrate-bootstrap shape
 * asserted by `assertCoordinatorSpecAgent` at
 * `workflow-service.ts:451`.
 */
export interface WorkflowStubCoordSpec {
  readonly agent: string;
}

export interface WorkflowStubCoordRunnerDeps {
  /**
   * Lazy getter so this runner factory can be constructed BEFORE
   * `composeWorkflowModule` returns. The compose call needs the
   * runner as an input and produces the `WorkflowService` as an
   * output; the thunk resolves the cycle by reading a closure
   * variable the caller assigns post-compose. Mirrors
   * `compose.ts:113`'s `service.setEngine(engine)` precedent.
   *
   * MUST return the same `WorkflowService` instance on every call
   * (the runner does not cache the result — see the
   * `dispatch`/`getDag` note about not caching the DAG snapshot
   * across `await` boundaries).
   */
  readonly getService: () => WorkflowService;

  /** Optional pino logger. Defaults to a silent pino instance. */
  readonly logger?: Logger;
}

const COORD_KIND = "coordinator";
const WORKER_KIND = "worker";

export function makeWorkflowStubCoordRunner(deps: WorkflowStubCoordRunnerDeps): WorkflowNodeRunner {
  const logger = deps.logger ?? silentLogger;

  const requireService = (): WorkflowService => {
    const s = deps.getService();
    if (s === null || s === undefined) {
      throw new Error(
        "WorkflowStubCoordRunner: service used before composeWorkflowModule returned (compose-time wiring forgot to set the ref)",
      );
    }
    return s;
  };

  return {
    async validate(spec: unknown, _ctx: WorkflowNodeValidateCtx): Promise<WorkflowStubCoordSpec> {
      if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
        throw new WorkflowNodeSpecError(COORD_KIND, "spec must be a plain object");
      }
      const obj = spec as Record<string, unknown>;
      if (typeof obj.agent !== "string" || obj.agent.trim().length === 0) {
        throw new WorkflowNodeSpecError(COORD_KIND, "spec requires non-empty string field 'agent'");
      }
      const extras = Object.keys(obj).filter((k) => k !== "agent");
      if (extras.length > 0) {
        throw new WorkflowNodeSpecError(
          COORD_KIND,
          `spec contains unexpected keys: ${extras.join(", ")}`,
        );
      }
      return { agent: obj.agent };
    },

    async dispatch(opts: {
      readonly workflowId: string;
      readonly nodeId: string;
      readonly spec: unknown;
      readonly nodeDir: string;
      readonly onTerminal: (result: WorkflowNodeTerminalResult) => void;
    }): Promise<{ readonly unitId: string }> {
      const service = requireService();
      // Fresh snapshot per dispatch — see `workflow-service.ts:374`
      // (`getDag`). Do NOT cache across an `await` boundary; the
      // DAG can change between calls (e.g. a `cancelWorkflow` races
      // in).
      const dag = await service.getDag(opts.workflowId);
      const coordCount = dag.nodes.filter((n) => n.kind === COORD_KIND).length;

      if (coordCount === 1) {
        const selfSpec = opts.spec as WorkflowStubCoordSpec;
        // addNode(worker) → addNode(follow-up coord) → onTerminal.
        // Order matters: firing onTerminal first flips this coord to
        // `succeeded`, which causes the substrate's caller-coord
        // auth gate (see `workflow-service.ts:1700` for the
        // dispatch-throw safety net and the unauthorized-mutation
        // class at `errors.ts`) to reject subsequent addNode calls.
        const { nodeId: workerId } = await service.addNode({
          workflowId: opts.workflowId,
          kind: WORKER_KIND,
          spec: {
            agent: WORKFLOW_STUB_WORKER_AGENT,
            brief: WORKFLOW_STUB_WORKER_BRIEF,
          },
          parents: [opts.nodeId],
        });
        await service.addNode({
          workflowId: opts.workflowId,
          kind: COORD_KIND,
          spec: { agent: selfSpec.agent },
          // Follow-up coord parents include both self and the worker
          // so the substrate's parent-readiness gate (see
          // `workflow-service.ts:1626`) holds the follow-up coord
          // until both the calling coord and the worker reach a
          // terminal state.
          parents: [opts.nodeId, workerId],
        });
        opts.onTerminal({ status: "succeeded" });
        return { unitId: `stub-coord-init:${opts.nodeId}` };
      }

      if (coordCount === 2) {
        // Find the unique non-coord parent of the follow-up coord
        // and map its terminal status onto a workflow outcome.
        const parentIds = new Set(dag.edges.filter((e) => e.to === opts.nodeId).map((e) => e.from));
        const workerParent = dag.nodes.find((n) => parentIds.has(n.id) && n.kind !== COORD_KIND);

        let outcome: "succeeded" | "failed";
        if (workerParent === undefined) {
          logger.warn(
            {
              workflowId: opts.workflowId,
              nodeId: opts.nodeId,
              parentIds: Array.from(parentIds),
            },
            "workflow-coord-runner: follow-up coord has no non-coord parent in DAG",
          );
          outcome = "failed";
        } else if (workerParent.status === "succeeded") {
          outcome = "succeeded";
        } else {
          // worker terminal in {'failed', 'cancelled'}; both map to
          // workflow outcome 'failed' (the cancelled-flow path goes
          // through `cancelWorkflow`, not `finishWorkflow` — see
          // `workflow-service.ts:868`).
          outcome = "failed";
        }

        await service.finishWorkflow({
          workflowId: opts.workflowId,
          outcome,
        });
        // The follow-up coord's own terminal status is always
        // `succeeded` (it successfully drove the workflow to a
        // terminal outcome), regardless of which outcome it picked.
        opts.onTerminal({ status: "succeeded" });
        return { unitId: `stub-coord-final:${opts.nodeId}` };
      }

      logger.error(
        {
          workflowId: opts.workflowId,
          nodeId: opts.nodeId,
          coordCount,
          message: "stub coord saw unexpected DAG shape",
        },
        "workflow-coord-runner: unexpected coord count in DAG",
      );
      opts.onTerminal({
        status: "failed",
        reason: `stub coord: unexpected DAG state (coordCount=${coordCount})`,
      });
      return { unitId: `stub-coord-unknown:${opts.nodeId}` };
    },

    async hasInFlightForNode(_nodeId: string): Promise<boolean> {
      return false;
    },

    async cancel(_nodeId: string): Promise<void> {
      // No-op: this runner is synchronous; by the time `dispatch`
      // returns, all mutations have committed and `onTerminal` has
      // fired. There is no out-of-band unit-of-work to cancel.
    },
  };
}

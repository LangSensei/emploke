/**
 * `makeCoordNodeRunner` — the coordinator-kind {@link
 * WorkflowNodeRunner} that maps a workflow coordinator node to a
 * `@emploke/task` task.
 *
 * Structurally the same machine as `workflow-task-runner.ts`
 * (worker): same per-node interval Map, same `clearForNode` /
 * `fireTerminal` helpers, same poll-tick state machine, same cancel
 * reconciliation, same dispose. The two runners are intentionally
 * duplicated rather than sharing helpers — the runner body is small,
 * the kinds may diverge (different polling cadence, different
 * spec/brief sources), and a shared helper module would couple two
 * otherwise independent dispatch paths.
 *
 * Divergence from the worker runner:
 *
 *   - Spec shape: `{ agent }` only (worker is
 *     `{ agent, brief, details?, runtime? }`). Extra keys are
 *     rejected (strict).
 *   - The task's `brief` / `details` come from the workflow header
 *     (read via `getService().getWorkflow(workflowId)` at dispatch
 *     time), NOT from the node spec. Coordinators are launched at
 *     workflow-create time with `{ agent: args.coordinatorAgent }`
 *     and inherit the workflow's prose for their TASK.md body — see
 *     `workflow-service.ts:438` for the bootstrap insert shape.
 *   - Two-phase init via the `getService` thunk: the workflow
 *     service is constructed by `composeWorkflowModule`, which
 *     itself requires the runners. The thunk lets the caller
 *     assign the service ref after compose returns — mirrors the
 *     engine ↔ service two-phase init at `compose.ts:113`.
 *
 * # Why `setInterval` lives here, not in `@emploke/workflow/_engine.ts`
 *
 * Same rationale as the worker runner: polling cadence is per-host
 * (a host driven by `@emploke/task` polls sqlite every 2s; a
 * different host could push terminal state without polling). Keep
 * polling local; push terminal state up via `onTerminal`.
 *
 * # Spec invariants honored
 *
 *   - `task.metadata.workflowNodeId` is the canonical reverse-lookup
 *     key (per `packages/workflow/src/types.ts:222`). Worker and
 *     coord runners use the SAME key — `tasks.hasInFlightForWorkflowNode`
 *     covers both kinds via the existing partial index.
 *   - `onTerminal` is fired exactly once per dispatched node by this
 *     runner (the interval is cleared the moment a terminal status
 *     is observed, and the per-node Map entry is dropped at the same
 *     time).
 *   - `dispatch` returns `void`. The runner logs the substrate-side
 *     identifier (the task id) at info level inside `dispatch` so
 *     operators can correlate substrate events with the underlying
 *     task; the substrate explicitly does NOT persist that id (per
 *     the same `types.ts:222` comment) because reverse-lookup goes
 *     through the unit's metadata.
 *   - No retry / no exponential backoff at the runner level; a
 *     single runner-local poll-error budget (`maxPollErrors`,
 *     default 3) maps repeated `tasks.get` failures to
 *     `onTerminal({status: 'failed', reason: 'tasks.get exhausted: ...'})`.
 */

import type { CatalogService } from "@emploke/catalog";
import { AgentNotFoundError, AgentResolutionFailedError, type TaskService } from "@emploke/task";
import type {
  WorkflowNodeRunner,
  WorkflowNodeTerminalResult,
  WorkflowNodeValidateCtx,
  WorkflowService,
} from "@emploke/workflow";
import pino, { type Logger } from "pino";

const silentLogger: Logger = pino({ level: "silent" });

/** Default poll cadence for `tasks.get(taskId)` in the coord runner. */
export const DEFAULT_COORD_POLL_INTERVAL_MS = 2000;
/** Default runner-local poll-error budget before surfacing as failed. */
export const DEFAULT_COORD_MAX_POLL_ERRORS = 3;

/**
 * Validated coord-spec shape. The substrate persists this as
 * `spec_json` and hands it back verbatim on dispatch. Matches the
 * bootstrap insert shape at `workflow-service.ts:438`
 * (`coordSpec = { agent: args.coordinatorAgent }`). Kept narrow
 * (single `agent` field) — additional per-coord configuration can
 * grow later without a contract break by widening this shape.
 */
export interface CoordNodeSpec {
  readonly agent: string;
}

/**
 * Wire-shape error for a malformed coord node spec. Lives next to
 * the runner (rather than in `@emploke/workflow`) because the
 * workflow pkg is kind-agnostic. Mirrors {@link WorkflowWorkerSpecError}
 * placement at `workflow-task-runner.ts:101`.
 */
export class WorkflowCoordSpecError extends Error {
  override readonly name = "WorkflowCoordSpecError";
}

export interface MakeCoordNodeRunnerDeps {
  readonly tasks: TaskService;
  readonly catalog: CatalogService;
  /**
   * Lazy getter for the {@link WorkflowService}. The runner needs it
   * to read the workflow header (`brief` / `details`) at dispatch
   * time, because `dispatch` opts hand the runner only the node-
   * level spec; `brief` / `details` live on the workflow row.
   *
   * Two-phase init: the workflow service is constructed by
   * `composeWorkflowModule`, which itself requires the runners.
   * Taking an eager `service: WorkflowService` would make it
   * impossible for the caller to construct the runner before compose
   * returns. The thunk lets the caller capture a ref, build the
   * runner, call compose, then assign the ref — mirrors the engine
   * ↔ service two-phase init at `compose.ts:113`.
   */
  readonly getService: () => WorkflowService;
  readonly logger?: Logger;
  /**
   * Override the default `tasks.get(...)` poll cadence. Tests pass
   * a low value (e.g. 50ms) so end-to-end scenarios complete in
   * vitest's tight budget; production callers rely on the default.
   */
  readonly pollIntervalMs?: number;
  /**
   * Override the runner-local poll-error budget. Consecutive
   * `tasks.get` failures landing on the same node beyond this count
   * surface as `onTerminal({status: 'failed', reason: '...'})`.
   */
  readonly maxPollErrors?: number;
}

/**
 * Factory for the coordinator-kind runner. Returns the {@link
 * WorkflowNodeRunner} the workflow substrate consumes, augmented
 * with a `dispose()` method the test composition's shutdown step
 * calls to clear any leaked polling intervals.
 *
 * The `dispose()` method is on the returned object's intersection
 * type, NOT on the `WorkflowNodeRunner` interface — the interface
 * keeps the 4-method contract (`validate / dispatch /
 * hasInFlightForNode / cancel`).
 */
export function makeCoordNodeRunner(
  deps: MakeCoordNodeRunnerDeps,
): WorkflowNodeRunner & { dispose(): Promise<void> } {
  const logger = deps.logger ?? silentLogger;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_COORD_POLL_INTERVAL_MS;
  const maxPollErrors = deps.maxPollErrors ?? DEFAULT_COORD_MAX_POLL_ERRORS;

  // Per-node interval handle. Cleared on terminal observation,
  // explicit cancel, or runner dispose. Without this the runner
  // leaks `setInterval` handles and the test process can't exit.
  const intervals = new Map<string, NodeJS.Timeout>();

  /**
   * Tear down the polling interval for `nodeId`. Idempotent — safe
   * to call when there's no recorded interval (e.g. terminal
   * observed before any tick fired).
   */
  const clearForNode = (nodeId: string): void => {
    const handle = intervals.get(nodeId);
    if (handle === undefined) return;
    clearInterval(handle);
    intervals.delete(nodeId);
  };

  /**
   * Fire `onTerminal` for `nodeId` and tear down the interval in
   * the SAME synchronous step so a slow `onTerminal` callback can't
   * be racing with a still-armed poll tick.
   */
  const fireTerminal = (
    nodeId: string,
    onTerminal: (result: WorkflowNodeTerminalResult) => void,
    result: WorkflowNodeTerminalResult,
  ): void => {
    clearForNode(nodeId);
    try {
      onTerminal(result);
    } catch (err) {
      logger.warn({ nodeId, err, result }, "workflow-coord-task-runner: onTerminal callback threw");
    }
  };

  return {
    async validate(spec: unknown, _ctx: WorkflowNodeValidateCtx): Promise<CoordNodeSpec> {
      if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
        throw new WorkflowCoordSpecError("Coord node spec must be an object");
      }
      const obj = spec as Record<string, unknown>;
      if (typeof obj.agent !== "string" || obj.agent.trim().length === 0) {
        throw new WorkflowCoordSpecError("Coord node spec requires non-empty agent");
      }
      // Strict shape: reject every key except `agent`. The coord
      // spec is intentionally narrow; unknown keys signal a wire-
      // shape mistake at the caller, not a feature the runner
      // silently drops.
      for (const k of Object.keys(obj)) {
        if (k !== "agent") {
          throw new WorkflowCoordSpecError(`Coord node spec rejects unknown key: ${k}`);
        }
      }

      // Catalog existence — mirrors `workflow-task-runner.ts:212-218`.
      // Checked at validate time so a bad agent name cannot land in
      // the DB and surface as a non-recoverable dispatch failure
      // later.
      let found: Awaited<ReturnType<typeof deps.catalog.getAgent>>;
      try {
        found = await deps.catalog.getAgent(obj.agent);
      } catch (err) {
        throw new AgentResolutionFailedError(obj.agent, err);
      }
      if (found === null) throw new AgentNotFoundError(obj.agent);

      return { agent: obj.agent };
    },

    async dispatch(opts): Promise<void> {
      // Resolve the service exactly once per dispatch — see the
      // `getService` thunk JSDoc above. The substrate guarantees the
      // ref is assigned by the time dispatch fires (post-compose),
      // but the runner should fail loudly rather than silently
      // dereference if a caller wires the runner without ever
      // calling compose.
      const service = deps.getService() as WorkflowService | null | undefined;
      if (service === null || service === undefined) {
        throw new Error(
          "workflow-coord-task-runner: getService() returned null/undefined; " +
            "compose-time wiring forgot to set the ref. " +
            "Build the runner with a thunk that closes over the WorkflowService " +
            "returned by composeWorkflowModule.",
        );
      }

      const wf = await service.getWorkflow(opts.workflowId);
      const spec = opts.spec as CoordNodeSpec;
      const task = await deps.tasks.dispatch({
        agent: spec.agent,
        brief: wf.brief,
        // Conditional spread: passing `details: undefined` into
        // `tasks.dispatch` can serialize as the literal string
        // "undefined" downstream. Mirrors the worker runner's
        // conditional spread at `workflow-task-runner.ts:223-224`.
        ...(wf.details !== undefined ? { details: wf.details } : {}),
        origin: "workflow",
        // `workflowNodeId` is the canonical reverse-lookup metadata
        // key per `packages/workflow/src/types.ts:222`; `workflowId`
        // is included for log correlation only. Worker and coord
        // runners use the SAME key — `tasks.hasInFlightForWorkflowNode`
        // covers both kinds via the existing partial index.
        metadata: {
          workflowId: opts.workflowId,
          workflowNodeId: opts.nodeId,
        },
      });
      const taskId = task.id;
      const nodeId = opts.nodeId;
      const onTerminal = opts.onTerminal;
      logger.info(
        { workflowId: opts.workflowId, nodeId, taskId },
        "workflow-coord-task-runner: dispatched coordinator task",
      );

      // If a previous dispatch on the same nodeId left an orphan
      // interval (shouldn't happen — the substrate guarantees a
      // single in-flight per node — but defense-in-depth in case a
      // test re-runs dispatch directly), wipe it before installing
      // the new one.
      clearForNode(nodeId);

      let consecutivePollErrors = 0;
      const handle = setInterval(() => {
        // Fire-and-forget: setInterval callbacks can't be async,
        // and any error we don't catch here would crash the process.
        void (async () => {
          let polled: Awaited<ReturnType<typeof deps.tasks.get>>;
          try {
            polled = await deps.tasks.get(taskId);
          } catch (err) {
            consecutivePollErrors += 1;
            logger.warn(
              {
                workflowId: opts.workflowId,
                nodeId,
                taskId,
                consecutivePollErrors,
                err,
              },
              "workflow-coord-task-runner: tasks.get threw",
            );
            if (consecutivePollErrors >= maxPollErrors) {
              fireTerminal(nodeId, onTerminal, {
                status: "failed",
                reason: `tasks.get exhausted: ${maxPollErrors} consecutive failures (last: ${
                  err instanceof Error ? err.message : String(err)
                })`,
              });
            }
            return;
          }
          consecutivePollErrors = 0;
          if (polled === null) {
            // Task deleted out from under us. Surface as a failure
            // with reason "task not found" — the workflow node has
            // no unit-of-work to wait on any more.
            fireTerminal(nodeId, onTerminal, {
              status: "failed",
              reason: "task not found",
            });
            return;
          }
          switch (polled.status) {
            case "running":
              return;
            case "succeeded":
              fireTerminal(nodeId, onTerminal, {
                status: "succeeded",
                output: polled.success ?? null,
              });
              return;
            case "failed":
              fireTerminal(nodeId, onTerminal, {
                status: "failed",
                reason: polled.failure?.message ?? "task failed (no reason recorded)",
                output: polled.failure ?? null,
              });
              return;
            case "cancelled":
              fireTerminal(nodeId, onTerminal, {
                status: "cancelled",
                reason: polled.cancellation?.message ?? "task cancelled (no reason recorded)",
              });
              return;
            default: {
              // Defense against a future TaskStatus arm we don't
              // know about. Treat as failure rather than silently
              // dropping; the runner is the layer that owns the
              // mapping and should fail loudly if it drifts.
              const unexpected: never = polled.status;
              fireTerminal(nodeId, onTerminal, {
                status: "failed",
                reason: `workflow-coord-task-runner: unexpected task status: ${unexpected as string}`,
              });
            }
          }
        })();
      }, pollIntervalMs);
      intervals.set(nodeId, handle);
    },

    async hasInFlightForNode(nodeId: string): Promise<boolean> {
      return deps.tasks.hasInFlightForWorkflowNode(nodeId);
    },

    async cancel(nodeId: string): Promise<void> {
      // Tear down the local interval FIRST so a poll-tick can't race
      // ahead and observe the cancellation as a generic terminal.
      clearForNode(nodeId);
      let inFlight: Awaited<ReturnType<typeof deps.tasks.listInFlightForWorkflowNode>>;
      try {
        inFlight = await deps.tasks.listInFlightForWorkflowNode(nodeId);
      } catch (err) {
        logger.warn(
          { nodeId, err },
          "workflow-coord-task-runner: listInFlightForWorkflowNode threw during cancel",
        );
        return;
      }
      // Best-effort, idempotent — per `WorkflowNodeRunner` contract
      // (`types.ts:282`). A throw on one task doesn't abort the
      // others; we log and continue.
      for (const t of inFlight) {
        try {
          await deps.tasks.cancel(t.id);
        } catch (err) {
          logger.warn(
            { nodeId, taskId: t.id, err },
            "workflow-coord-task-runner: tasks.cancel threw",
          );
        }
      }
    },

    async dispose(): Promise<void> {
      for (const handle of intervals.values()) {
        clearInterval(handle);
      }
      intervals.clear();
    },
  };
}

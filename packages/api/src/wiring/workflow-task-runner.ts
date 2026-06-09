// "task" in this filename refers to the @emploke/task dispatch
// mechanism this runner uses (visible at the deps.tasks.dispatch call
// inside dispatch()), not the workflow-node wire `kind` — which is
// "worker" (this runner) or "coordinator" (sibling runner).

/**
 * `makeWorkerNodeRunner` — the worker-kind {@link
 * WorkflowNodeRunner} that maps a workflow worker node to a
 * `@emploke/task` task.
 *
 * Sole module knowing about all of `@emploke/workflow`,
 * `@emploke/task`, AND `@emploke/catalog`. This is the only edge in
 * the cross-pkg import graph where the three meet — the workflow pkg
 * stays kind-agnostic (its `WorkflowNodeRunner` interface is the
 * seam); the task pkg stays unaware of workflows' DAG; and the
 * catalog pkg is consumed only here for agent existence.
 *
 * Responsibilities (the kind-specific concerns the workflow pkg
 * deliberately doesn't carry, absorbed here):
 *
 *   - worker spec-shape validation
 *   - agent existence lookup (mirroring `schedule-task-handler.ts`)
 *   - origin/metadata synthesis for `TaskService.dispatch`
 *   - polling `tasks.get(...)` to discover terminal status
 *   - mapping `TaskStatus` → `WorkflowNodeTerminalResult`
 *   - bookkeeping the per-node `setInterval` handle so `dispose()`
 *     and `cancel(nodeId)` can clear it without leaking timers
 *
 * `validate(spec, _)` checks the inbound payload shape and verifies
 * the named agent exists in the catalog using the canonical task-pkg
 * error classes (`AgentNotFoundError` / `AgentResolutionFailedError`)
 * — matching `schedule-task-handler.ts`'s precedent.
 *
 * Agent errors are RAISED USING TASK-PKG'S CLASSES directly so any
 * downstream error policy (today only `@emploke/server`'s
 * `schedulesErrorPolicy`; the workflow-route policy will reuse the
 * same row in a later milestone) has a single canonical match.
 *
 * # Why `setInterval` lives here, not in `@emploke/workflow/_engine.ts`
 *
 * The engine is event-driven and contains zero timers. Polling
 * cadence is the runner's concern because it is per-host: a worker
 * driven by `@emploke/task` polls a sqlite read every 2s; a
 * different host could choose a different cadence (or skip polling
 * entirely and push terminal state via an in-process event).
 * Centralizing this would force one cadence on every host — and
 * would still need a runner-side "tell me when the unit
 * terminated" callback for non-poll hosts. Keep polling local;
 * push terminal state up via `onTerminal`.
 *
 * # Spec invariants honored
 *
 * - `task.metadata.workflowNodeId` is the canonical reverse-lookup
 *   key (per `packages/workflow/src/types.ts:222`). This module never
 *   asks the substrate to persist the task id; reverse-lookup goes
 *   through this metadata key via
 *   `TaskService.hasInFlightForWorkflowNode` / `listInFlightForWorkflowNode`.
 * - `onTerminal` is fired exactly once per dispatched node by this
 *   runner (the interval is cleared the moment a terminal status is
 *   observed, and the per-node Map entry is dropped at the same time).
 * - `dispatch` returns `void`. The runner logs the substrate-side
 *   identifier (the task id) at info level inside `dispatch` so
 *   operators can correlate substrate events with the underlying
 *   task; the substrate explicitly does NOT persist that id (per the
 *   same `types.ts:222` comment) because reverse-lookup goes through
 *   the unit's metadata.
 * - No retry, no exponential backoff at the runner level; a single
 *   runner-local poll-error budget (`maxPollErrors`, default 3)
 *   maps repeated `tasks.get` failures to
 *   `onTerminal({status: 'failed', reason: 'tasks.get exhausted: ...'})`.
 */

import type { CatalogService } from "@emploke/catalog";
import { AgentNotFoundError, AgentResolutionFailedError, type TaskService } from "@emploke/task";
import type {
  WorkflowNodeRunner,
  WorkflowNodeTerminalResult,
  WorkflowNodeValidateCtx,
} from "@emploke/workflow";
import pino, { type Logger } from "pino";

const silentLogger: Logger = pino({ level: "silent" });

/** Default poll cadence for `tasks.get(taskId)` in the worker runner. */
export const DEFAULT_WORKER_POLL_INTERVAL_MS = 2000;
/** Default runner-local poll-error budget before surfacing as failed. */
export const DEFAULT_WORKER_MAX_POLL_ERRORS = 3;

/**
 * Validated worker-spec shape. The substrate persists this as
 * `spec_json` and hands it back verbatim on dispatch. Kept narrow
 * (`agent`/`brief`/optional `details`/optional `runtime`) — adaptive
 * fields or per-runtime hints can grow later without a contract
 * break by spreading them onto the same object.
 */
export interface WorkerNodeSpec {
  readonly agent: string;
  readonly brief: string;
  readonly details?: string;
  readonly runtime?: string;
}

/**
 * Wire-shape error for a malformed worker node spec. Lives next to
 * the handler (rather than in `@emploke/workflow`) because the
 * workflow pkg is kind-agnostic. Matches the pattern from
 * {@link TaskScheduleTargetError} in `schedule-task-handler.ts`.
 */
export class WorkflowWorkerSpecError extends Error {
  override readonly name = "WorkflowWorkerSpecError";
}

export interface MakeWorkerNodeRunnerDeps {
  readonly tasks: TaskService;
  readonly catalog: CatalogService;
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
 * Factory for the worker-kind runner. Returns the {@link
 * WorkflowNodeRunner} the workflow substrate consumes, augmented
 * with a `dispose()` method the test composition's shutdown step
 * calls to clear any leaked polling intervals.
 *
 * The `dispose()` method is on the returned object's intersection
 * type, NOT on the `WorkflowNodeRunner` interface — the interface
 * keeps the 4-method contract (`validate / dispatch /
 * hasInFlightForNode / cancel`).
 */
export function makeWorkerNodeRunner(
  deps: MakeWorkerNodeRunnerDeps,
): WorkflowNodeRunner & { dispose(): Promise<void> } {
  const logger = deps.logger ?? silentLogger;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  const maxPollErrors = deps.maxPollErrors ?? DEFAULT_WORKER_MAX_POLL_ERRORS;

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
      logger.warn({ nodeId, err, result }, "workflow-task-runner: onTerminal callback threw");
    }
  };

  return {
    async validate(spec: unknown, _ctx: WorkflowNodeValidateCtx): Promise<WorkerNodeSpec> {
      if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
        throw new WorkflowWorkerSpecError("Worker node spec must be an object");
      }
      const obj = spec as Record<string, unknown>;
      if (typeof obj.agent !== "string" || obj.agent.trim().length === 0) {
        throw new WorkflowWorkerSpecError("Worker node spec requires non-empty agent");
      }
      if (typeof obj.brief !== "string" || obj.brief.trim().length === 0) {
        throw new WorkflowWorkerSpecError("Worker node spec requires non-empty brief");
      }
      if (obj.brief.includes("\n") || obj.brief.includes("\r")) {
        throw new WorkflowWorkerSpecError(
          "Worker node spec brief must be a single line (no newline characters); pass long content via details",
        );
      }
      if (obj.brief.trim().length > 200) {
        throw new WorkflowWorkerSpecError("Worker node spec brief must be 200 characters or fewer");
      }
      if (obj.details !== undefined && typeof obj.details !== "string") {
        throw new WorkflowWorkerSpecError("Worker node spec details, when set, must be a string");
      }
      if (
        obj.runtime !== undefined &&
        (typeof obj.runtime !== "string" || obj.runtime.trim().length === 0)
      ) {
        throw new WorkflowWorkerSpecError(
          "Worker node spec runtime, when set, must be a non-empty string",
        );
      }

      // Catalog existence — mirror schedule-task-handler.ts. Always
      // checked at validate time for workflow worker nodes (unlike
      // schedules, the workflow pkg does not propagate a `changedKeys`
      // hint into `validate`).
      let found: Awaited<ReturnType<typeof deps.catalog.getAgent>>;
      try {
        found = await deps.catalog.getAgent(obj.agent);
      } catch (err) {
        throw new AgentResolutionFailedError(obj.agent, err);
      }
      if (found === null) throw new AgentNotFoundError(obj.agent);

      const validated: WorkerNodeSpec = {
        agent: obj.agent,
        brief: obj.brief,
        ...(obj.details !== undefined ? { details: obj.details } : {}),
        ...(obj.runtime !== undefined ? { runtime: obj.runtime } : {}),
      };
      return validated;
    },

    async dispatch(opts): Promise<void> {
      const spec = opts.spec as WorkerNodeSpec;
      const task = await deps.tasks.dispatch({
        agent: spec.agent,
        brief: spec.brief,
        ...(spec.details !== undefined ? { details: spec.details } : {}),
        ...(spec.runtime !== undefined ? { runtime: spec.runtime } : {}),
        origin: "workflow",
        // `workflowNodeId` is the canonical reverse-lookup metadata
        // key per `packages/workflow/src/types.ts:222`; `workflowId`
        // is included for log correlation only. Do NOT rename either
        // key without updating the corresponding partial-index /
        // hasInFlightForWorkflowNode SQL predicate.
        metadata: {
          workflowId: opts.workflowId,
          workflowNodeId: opts.nodeId,
        },
        // Worker tasks see the two workflow identity keys
        // (`EMPLOKE_WORKFLOW_ID`, `EMPLOKE_NODE_ID`) but NOT
        // `EMPLOKE_WORKFLOW_DIR` — the per-workflow shared dir is
        // coord-only by design. Coord owns that dir; workers stay
        // workflow-unaware so the coord skill's "workers do not
        // read the shared dir" rule holds by construction. The
        // restriction is doc-only — the runtime does not enforce
        // read-only on the dir, so the discipline is: do NOT add
        // the key here unless a deliberate spec change widens the
        // contract.
        //
        // No `prompt` override: workers use `@emploke/task`'s default
        // `TASK_FRAMING_PROMPT_COPILOT`. Worker briefs are self-
        // contained TASK.md bodies; the default framing's "read
        // TASK.md, then exit" instruction is exactly right.
        subprocessEnv: {
          EMPLOKE_WORKFLOW_ID: opts.workflowId,
          EMPLOKE_NODE_ID: opts.nodeId,
        },
      });
      const taskId = task.id;
      const nodeId = opts.nodeId;
      const onTerminal = opts.onTerminal;
      logger.info(
        { workflowId: opts.workflowId, nodeId, taskId },
        "workflow-task-runner: dispatched worker task",
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
          let task: Awaited<ReturnType<typeof deps.tasks.get>>;
          try {
            task = await deps.tasks.get(taskId);
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
              "workflow-task-runner: tasks.get threw",
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
          if (task === null) {
            // Task deleted out from under us. Surface as a failure
            // with reason "task not found" — the workflow node has
            // no unit-of-work to wait on any more.
            fireTerminal(nodeId, onTerminal, {
              status: "failed",
              reason: "task not found",
            });
            return;
          }
          switch (task.status) {
            case "running":
              return;
            case "succeeded":
              fireTerminal(nodeId, onTerminal, {
                status: "succeeded",
                output: task.success ?? null,
              });
              return;
            case "failed":
              fireTerminal(nodeId, onTerminal, {
                status: "failed",
                reason: task.failure?.message ?? "task failed (no reason recorded)",
                output: task.failure ?? null,
              });
              return;
            case "cancelled":
              fireTerminal(nodeId, onTerminal, {
                status: "cancelled",
                reason: task.cancellation?.message ?? "task cancelled (no reason recorded)",
              });
              return;
            default: {
              // Defense against a future TaskStatus arm we don't
              // know about. Treat as failure rather than silently
              // dropping; the runner is the layer that owns the
              // mapping and should fail loudly if it drifts.
              const unexpected: never = task.status;
              fireTerminal(nodeId, onTerminal, {
                status: "failed",
                reason: `workflow-task-runner: unexpected task status: ${unexpected as string}`,
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
          "workflow-task-runner: listInFlightForWorkflowNode threw during cancel",
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
          logger.warn({ nodeId, taskId: t.id, err }, "workflow-task-runner: tasks.cancel threw");
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

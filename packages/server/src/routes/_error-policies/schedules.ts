/**
 * Per-domain error policy for the schedules routes.
 *
 * Source of truth for the (class, status) pairs is the
 * `statusForScheduleError` function from before the policy-table
 * refactor in `routes/schedules.ts`.
 *
 * ## Why agent errors come from `@emploke/task`
 *
 * The schedule pkg is a kind-agnostic substrate (issue #257). It
 * does not know what an "agent" is and does not throw agent-related
 * errors directly. The task-kind handler in
 * `packages/api/src/wiring/schedule-task-handler.ts` performs the
 * catalog existence lookup during `validate(data)` and throws
 * `@emploke/task`'s `AgentNotFoundError` / `AgentResolutionFailedError`
 * directly on miss / failure. Those errors propagate through
 * `ScheduleService.create` / `.patch` untouched, so the schedules
 * route policy only needs ONE row each (the previous design's
 * duplicate schedule-pkg classes are gone). The same rows also cover
 * the `POST /:sid/run` path, which dispatches a task via the same
 * handler.
 *
 * ## Fallthrough into the task-package
 *
 * `POST /:sid/run` invokes `TaskService.dispatch` (via the handler)
 * which can surface other task-pkg errors at runtime
 * (`EntryNotReadyError → 409`, `ManagerShuttingDownError → 503`,
 * etc.). Those rows are listed below so callers don't have to read
 * two policy files to predict status.
 */

import { TaskScheduleTargetError } from "@emploke/api";
import { RuntimeHeadlessLaunchFailed } from "@emploke/runtime";
import {
  InvalidCronExprError,
  InvalidJsonPathError,
  InvalidScheduleIdError,
  InvalidTimezoneError,
  ScheduleEnabledError,
  ScheduleError,
  ScheduleHasInFlightError,
  ScheduleKindAlreadyRegisteredError,
  ScheduleKindMismatchError,
  ScheduleKindNotRegisteredError,
  ScheduleKindRegistryFrozenError,
  ScheduleNotFoundError,
} from "@emploke/schedule";
import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
  InvalidTransition,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "@emploke/task";
import type { ErrorPolicy } from "../_respond-error.js";
import { opaqueAgentResolutionBody } from "./_shared-bodies.js";

export const schedulesErrorPolicy: ErrorPolicy = {
  name: "schedules",
  statuses: [
    [InvalidScheduleIdError, 400],
    [InvalidCronExprError, 400],
    [InvalidTimezoneError, 400],
    [InvalidJsonPathError, 400],
    // Task-kind-handler-side input validation (the handler's
    // `validate` rejects malformed task target data — wire-side
    // duplicate of `validateTaskTargetData` for defense-in-depth).
    // Lives in `@emploke/api` because the kind handler is wired
    // there; reaches the policy via api's public surface.
    [TaskScheduleTargetError, 400],
    [ScheduleNotFoundError, 404],
    [ScheduleKindMismatchError, 404],
    [ScheduleEnabledError, 409],
    [ScheduleHasInFlightError, 409],
    // Operator-config bugs (the wiring layer forgot a registerKind
    // call, or registered twice, or ran recover() too early). These
    // are 500s with opaque bodies — they should never reach a
    // production wire surface in a healthy deploy, but if they do
    // the response shouldn't leak the kind name.
    [ScheduleKindNotRegisteredError, 500, opaqueAgentResolutionBody],
    [ScheduleKindAlreadyRegisteredError, 500, opaqueAgentResolutionBody],
    [ScheduleKindRegistryFrozenError, 500, opaqueAgentResolutionBody],
    // `ScheduleError` is the abstract base — listed LAST among
    // schedule-package entries so concrete subclasses (e.g.
    // `InvalidCronExprError`) match first.
    [ScheduleError, 400],

    // Task-package surface. ONE row per class — these cover BOTH
    // the create / patch validation path (the task handler calls
    // catalog.getAgent and re-throws as task-pkg's AgentNotFoundError
    // / AgentResolutionFailedError) AND the `POST /:sid/run` task
    // dispatch path. The schedule pkg is kind-agnostic and does not own
    // agent-related classes; the open-registry design pushes that
    // responsibility into the task-kind handler so the policy has a
    // single source of truth per class.
    [InvalidTaskIdError, 400],
    [TaskNotFoundError, 404],
    [AgentNotFoundError, 400],
    [AgentResolutionFailedError, 500, opaqueAgentResolutionBody],
    [RuntimeDoesNotSupportTasksError, 400],
    [
      EntryNotReadyError,
      409,
      (err) => {
        const e = err as EntryNotReadyError;
        return {
          error: e.message,
          code: e.name,
          agent: e.agent,
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        };
      },
    ],
    [InvalidTransition, 409],
    [ManagerShuttingDownError, 503],
    [TaskIdAllocationFailedError, 500],
    [RuntimeHeadlessLaunchFailed, 500],
    [CorruptedTaskError, 500],
  ],
};

/**
 * Per-domain error policy for the schedules routes.
 *
 * Source of truth for the (class, status) pairs is the pre-refactor
 * `statusForScheduleError` function in `routes/schedules.ts`.
 *
 * Institutional knowledge from the pre-refactor shadow (PR #241 — why
 * the schedule-package `AgentNotFoundError` MUST be listed explicitly):
 *
 *   The schedule-package `AgentNotFoundError` and the task-package
 *   `AgentNotFoundError` share the same .name string but are distinct
 *   classes. A name-string switch can't distinguish them, and at the
 *   schedule-route layer we want both to map to 400 (caller-fixable
 *   input). Listing the schedule-package class explicitly means this
 *   route's `respondError` finds a typed match instead of falling
 *   through to the task-policy chain, so its 400 doesn't trip the
 *   `isUnmapped` log path (the original intent of the shadow's
 *   typed-branch-not-fallthrough comment in `statusForScheduleError`).
 *
 * Fallthrough: the `POST /:sid/run` handler invokes
 * `TaskService.dispatch` under the hood, so task-package errors
 * (EntryNotReadyError → 409, ManagerShuttingDownError → 503, etc.)
 * leak through. The pre-refactor `statusForScheduleError` chained to
 * `statusForError` for exactly this; here we spell out the same
 * task-package entries (cheap, ~10 lines) so callers don't have to
 * read two policy files to predict status. The order is:
 * schedule-package classes first, then task-package classes; both
 * `AgentNotFoundError` rows fire correctly because each row matches
 * only its own class via `instanceof`.
 */

import { RuntimeHeadlessLaunchFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
  InvalidCronExprError,
  InvalidScheduleIdError,
  InvalidTimezoneError,
  ScheduleEnabledError,
  ScheduleError,
  ScheduleHasInFlightError,
  ScheduleKindMismatchError,
  ScheduleNotFoundError,
} from "@emploke/schedule";
import {
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
  InvalidTransition,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  AgentNotFoundError as TaskAgentNotFoundError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "@emploke/task";
import type { ErrorPolicy } from "../_respond-error.js";

export const schedulesErrorPolicy: ErrorPolicy = {
  name: "schedules",
  statuses: [
    [InvalidScheduleIdError, 400],
    [InvalidCronExprError, 400],
    [InvalidTimezoneError, 400],
    [AgentNotFoundError, 400],
    [ScheduleNotFoundError, 404],
    [ScheduleKindMismatchError, 404],
    [ScheduleEnabledError, 409],
    [ScheduleHasInFlightError, 409],
    // `ScheduleError` is the abstract base — listed LAST among
    // schedule-package entries so concrete subclasses (e.g.
    // `InvalidCronExprError`) match first.
    [ScheduleError, 400],

    // Task-package fallthrough (POST /:sid/run dispatches a task).
    [InvalidTaskIdError, 400],
    [TaskNotFoundError, 404],
    [TaskAgentNotFoundError, 400],
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

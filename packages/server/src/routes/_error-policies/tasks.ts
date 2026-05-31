/**
 * Per-domain error policy for the tasks + scheduled-tasks routes.
 *
 * Source of truth for the (class, status) pairs is the pre-refactor
 * `statusForError` function in `_shared.ts`. Every entry below was
 * lifted byte-for-byte from that switch; do not invent new mappings
 * without updating the route contract.
 *
 * `EntryNotReadyError` carries a class-stable body (`{ error, code,
 * agent, reason }`) lifted from the inline branch in `routes/tasks.ts`
 * — the dashboard's `formatEntryNotReadyHint` CTA branches on `reason`,
 * so the structured envelope MUST be preserved.
 *
 * `InvalidTransition`'s status is here but its body is route-dependent
 * (`{ ..., transition: "cancel" | "delete" }`) and is built per-call
 * via `RespondErrorOpts.customBody`.
 */

import { RuntimeHeadlessLaunchFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
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

export const tasksErrorPolicy: ErrorPolicy = {
  name: "tasks",
  statuses: [
    [InvalidTaskIdError, 400],
    [TaskNotFoundError, 404],
    [AgentNotFoundError, 400],
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

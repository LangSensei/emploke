import type { TaskDispatcher } from "@emploke/schedule";
import type { TaskService } from "@emploke/task";

/**
 * Bridge `@emploke/schedule`'s `TaskDispatcher` over `@emploke/task`'s
 * `TaskService.dispatch`. Post-redesign (RFC #61 v2) the two shapes
 * line up directly — `brief` + `details?` are now first-class fields
 * on `ScheduleTarget.task`, so no synthesis is needed. The adapter
 * stays as structural decoupling: the `schedule` pkg never imports
 * `@emploke/task`, and this file is the only place that knows about
 * both.
 */
export function makeScheduleTaskDispatcher(tasks: TaskService): TaskDispatcher {
  return {
    async dispatch({ agent, brief, details, runtime, origin, metadata }) {
      const result = await tasks.dispatch({
        agent,
        brief,
        // `{ details: undefined }` is NOT equivalent to omitting the
        // key under exactOptionalPropertyTypes; conditional spread.
        ...(details !== undefined ? { details } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
        origin,
        metadata,
      });
      return { id: result.id };
    },
    hasInFlightForSchedule(scheduleId) {
      return tasks.hasInFlightForSchedule(scheduleId);
    },
    deleteForSchedule(scheduleId) {
      return tasks.deleteForSchedule(scheduleId);
    },
  };
}

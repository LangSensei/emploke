import type { TaskDispatcher } from "@emploke/schedule";
import type { TaskService } from "@emploke/task";

/**
 * Bridge `@emploke/schedule`'s `TaskDispatcher` over `@emploke/task`'s
 * `TaskService.dispatch`. The shape mismatch — schedule hands over
 * `instructions` (a single field), task wants `brief` + `details?` —
 * is reconciled here:
 *
 *   - `brief`: first line of `instructions`, trimmed, hard-clipped to
 *     200 chars (with an ellipsis). Falls back to a deterministic
 *     synth (`Scheduled run <scheduleId>`) when `instructions` is
 *     empty / blank.
 *   - `details`: the full `instructions` string, unchanged.
 *
 * We do NOT look up `Schedule.name` here even though it would be a
 * nicer brief — that would require an injected `ScheduleService` and
 * create a cyclic dep through `composeScheduleModule`, which itself
 * takes a `TaskDispatcher`. A future PR can break the cycle by
 * widening `TaskDispatcher.dispatch` opts with an optional
 * `displayName?` and having `ScheduleService` thread `entity.name`
 * through; tracked as follow-up, not blocking for v1.
 */
export function makeScheduleTaskDispatcher(tasks: TaskService): TaskDispatcher {
  return {
    async dispatch({ agent, instructions, runtime, origin, metadata }) {
      const brief = synthesizeBrief(instructions, metadata.scheduleId);
      const result = await tasks.dispatch({
        agent,
        brief,
        details: instructions,
        // `{ runtime: undefined }` is NOT equivalent to omitting the
        // key under exactOptionalPropertyTypes; conditional spread.
        ...(runtime !== undefined ? { runtime } : {}),
        origin,
        metadata,
      });
      return { id: result.id };
    },
    hasInFlightForSchedule(scheduleId) {
      return tasks.hasInFlightForSchedule(scheduleId);
    },
  };
}

function synthesizeBrief(instructions: string, scheduleId: string): string {
  const firstLine = (instructions.split(/\r?\n/, 1)[0] ?? "").trim();
  if (firstLine.length === 0) {
    return `Scheduled run ${scheduleId}`;
  }
  if (firstLine.length > 200) {
    return `${firstLine.slice(0, 197)}...`;
  }
  return firstLine;
}

/**
 * Public API of `@emploke/schedule`.
 *
 * Cron-triggered task dispatch as a substrate-side referee
 * (`docs/paradigm.md` §"Scheduling"). `ScheduleService` owns the
 * trigger; the dispatched task is the responsibility of the injected
 * `TaskDispatcher` (production binding = `@emploke/task`'s
 * `TaskService.dispatch` + `hasInFlightForSchedule`).
 *
 * Construction: `composeScheduleModule({ dbFile, taskDispatcher, agentValidator })`.
 * Tests use `openTestScheduleDb()` from `./testing`.
 */

export {
  composeScheduleModule,
  type ScheduleModule,
  type ScheduleModuleOptions,
} from "./compose.js";
export { describeCron } from "./cron.js";
export {
  AgentNotFoundError,
  InvalidCronExprError,
  InvalidScheduleIdError,
  InvalidTimezoneError,
  ScheduleEnabledError,
  ScheduleError,
  ScheduleHasInFlightError,
  ScheduleKindMismatchError,
  ScheduleNotFoundError,
} from "./errors.js";
export { ScheduleService } from "./schedule-service.js";
export type {
  CreateTaskScheduleArgs,
  ListScheduleOpts,
  PatchTaskScheduleArgs,
  PreviewResult,
  Schedule,
  ScheduleTarget,
  ScheduleTrigger,
  TaskDispatcher,
  TaskScheduleTarget,
  TaskTargetData,
  TaskTargetPatch,
} from "./types.js";

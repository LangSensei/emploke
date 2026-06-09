/**
 * @emploke/task — TaskService (Drizzle-backed) + Task DTO.
 *
 * The `TaskEntity` class with state-machine methods is internal to
 * this package. External consumers see the `Task` DTO returned by
 * `TaskService` reads/writes.
 */

export { composeTaskModule, type TaskModule, type TaskModuleOptions } from "./compose.js";
export {
  AgentNotFoundError,
  AgentResolutionFailedError,
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
  InvalidTransition,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  TaskError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "./errors.js";
export {
  assertFramingPromptIsSafe,
  formatTaskMd,
  TASK_ARTIFACT_SUBDIR,
  TASK_FILENAME,
  TASK_FRAMING_PROMPT_COPILOT,
  TASK_TEMP_SUBDIR,
} from "./framing.js";
export { safeJoinUnderRoot, tasksRoot } from "./paths.js";
export type {
  AgentEntry,
  AgentResolverPort,
  BlockedDep,
  BlockedReason,
  MissingDep,
} from "./ports.js";
export type { TaskRuntimeMetadata } from "./task-meta.js";
export { readTaskRuntimeMetadata } from "./task-meta.js";
export { TaskService } from "./task-service.js";
export type {
  DispatchOpts,
  ListTaskOpts,
  Task,
  TaskCancellation,
  TaskFailure,
  TaskOrigin,
  TaskServiceConfig,
  TaskStatus,
  TaskSuccess,
  TerminalStatus,
} from "./types.js";
export { assertValidTaskId, generateTaskId, TASK_ID_RE } from "./validate.js";
export { listWorkdirFiles } from "./workdir.js";

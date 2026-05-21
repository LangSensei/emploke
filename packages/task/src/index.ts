/**
 * @emploke/task — Task entity + TaskManager (Drizzle-backed).
 */

export { composeTaskModule, type TaskModule, type TaskModuleOptions } from "./compose.js";
export {
  AgentNotFoundError,
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
export { TaskManager } from "./manager.js";
export { safeJoinUnderRoot } from "./paths.js";
export { TaskRepository } from "./repository.js";
export { type NewTaskRow, type TaskRow, tasks } from "./schema.js";
export {
  Task,
  type TaskCreateArgs,
  type TaskFromStoredArgs,
  type TaskTransitionOpts,
} from "./task-entity.js";
export { readTaskRuntimeMetadata, type TaskRuntimeMetadata } from "./task-meta.js";
export type {
  DispatchOpts,
  ListTaskOpts,
  TaskCancellation,
  TaskFailure,
  TaskManagerConfig,
  TaskOrigin,
  TaskStatus,
  TaskSuccess,
  TerminalStatus,
} from "./types.js";
export { assertValidTaskId, generateTaskId, TASK_ID_RE } from "./validate.js";

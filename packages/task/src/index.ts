/**
 * @emploke/task — Task entity + TaskManager.
 *
 * Quick start:
 *
 * ```ts
 * import { Task } from "@emploke/task";
 *
 * const t0 = Task.create({ agent: "writer", instructions: "Draft the post" });
 * const t1 = t0.start({ metadata: { pid: 12345 } });
 * const t2 = t1.complete("draft.md written");
 * // t2.status === "success", t2.result?.output === "draft.md written"
 * ```
 *
 * Design:
 *  - `Task` is an immutable DDD entity; every state-transition method
 *    (`start` / `complete` / `fail` / `cancel`) returns a new instance.
 *  - Runtime details (pid, sessionFile, workDir, …) live in `metadata`,
 *    not as named fields, so the entity never has to change.
 *  - State methods throw {@link InvalidTransition} for illegal events.
 *  - There is no pause/resume — emploke runtimes can't truly pause a
 *    detached process. If a "soft pause" UX is needed later, model it
 *    in metadata, not in entity status.
 *
 * The `TaskManager` class wraps the entity with on-disk persistence,
 * runtime spawn, and lifecycle (shutdown / orphan recovery). It is the
 * normal entry point for hosting code (e.g. `@emploke/server`); the
 * `Task` static + instance methods are exported for callers that want
 * to drive the entity directly (e.g. tests, custom orchestrators).
 */

export {
  AgentNotFoundError,
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
  InvalidTransition,
  RuntimeDoesNotSupportTasksError,
  TaskError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
} from "./errors.js";
export {
  assertFramingPromptIsSafe,
  framingPromptFor,
  TASK_ARTIFACT_SUBDIR,
  TASK_FILENAME,
  TASK_FRAMING_PROMPT_COPILOT,
  TASK_TEMP_SUBDIR,
} from "./framing.js";
export {
  assertValidTaskId,
  generateTaskId,
  TASK_ID_RE,
} from "./ids.js";
export { TaskManager } from "./manager.js";
export { safeJoinUnderRoot } from "./paths.js";
export type { TaskRepository } from "./repositories/repository.js";
export { SqliteTaskRepository } from "./repositories/sqlite-task-repository.js";
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
  TaskFailure,
  TaskManagerConfig,
  TaskResult,
  TaskStatus,
  TerminalStatus,
} from "./types.js";

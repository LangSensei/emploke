/**
 * @emploke/task — pure value type + state machine for tasks.
 *
 * Quick start:
 *
 * ```ts
 * import { create, apply } from "@emploke/task";
 *
 * const t0 = create({ agent: "writer", instructions: "Draft the post" });
 * const t1 = apply(t0, { type: "start", metadata: { pid: 12345 } });
 * const t2 = apply(t1, { type: "complete", output: "draft.md written" });
 * // t2.status === "success", t2.result?.output === "draft.md written"
 * ```
 *
 * Design:
 *  - `Task` is an immutable value; `apply()` returns a new task.
 *  - Runtime details (pid, sessionFile, workDir, …) live in `metadata`,
 *    not as named fields, so the kernel never has to change.
 *  - `apply()` throws {@link InvalidTransition} for illegal events.
 *  - There is no pause/resume — emploke runtimes can't truly pause a
 *    detached process. If a "soft pause" UX is needed later, model it
 *    in metadata, not in kernel state.
 *
 * The `TaskManager` class wraps the kernel with on-disk persistence,
 * runtime spawn, and lifecycle (shutdown / orphan recovery). It is the
 * normal entry point for hosting code (e.g. `@emploke/server`); the
 * `apply` / `create` primitives below are exported for callers that
 * want to drive the FSM directly (e.g. tests, custom orchestrators).
 */

export { apply } from "./apply.js";
export { type CreateParams, create } from "./create.js";
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
  assertValidTaskId,
  generateTaskId,
  TASK_ID_RE,
} from "./ids.js";
export { createDirJunction } from "./junction.js";
export { TaskManager } from "./manager.js";
export { safeJoinUnderRoot } from "./paths.js";
export { FsTaskRepository } from "./repositories/fs-task-repository.js";
export type { TaskRepository } from "./repositories/repository.js";
export { readTaskRuntimeMetadata, type TaskRuntimeMetadata } from "./task-meta.js";
export type {
  CancelEvent,
  CompleteEvent,
  DispatchOpts,
  FailEvent,
  ListTaskOpts,
  Logger,
  StartEvent,
  Task,
  TaskEvent,
  TaskFailure,
  TaskManagerConfig,
  TaskResult,
  TaskStatus,
  TerminalStatus,
} from "./types.js";

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
 */

export { apply } from "./apply.js";
export { type CreateParams, create } from "./create.js";
export { InvalidTransition, TaskError } from "./errors.js";
export type {
  CancelEvent,
  CompleteEvent,
  FailEvent,
  StartEvent,
  Task,
  TaskEvent,
  TaskFailure,
  TaskResult,
  TaskStatus,
  TerminalStatus,
} from "./types.js";

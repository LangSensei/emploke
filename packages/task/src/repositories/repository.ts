import type { ListTaskOpts, Task } from "../types.js";

/**
 * Storage contract for tasks. Implementations decide where the task
 * records actually live (per-task JSON file, SQL row, ...) — callers
 * never see persistence shape.
 *
 * Per-instance scope: a `TaskRepository` instance covers exactly one
 * workspace's task collection. Multi-workspace deployments instantiate
 * one repository per workspace; the cache layer
 * (`WorkspaceContextCache`) does this implicitly.
 *
 * Concurrency: per-id writes don't need cross-process serialisation in
 * practice (`TaskManager` already serialises via its `live` map and
 * the FSM). The FS implementation does atomic file writes (tmpfile +
 * rename + EPERM retry), which is enough on its own.
 */
export interface TaskRepository {
  /**
   * Read one task by id. Returns `null` when no task with that id is
   * known. Throws `CorruptedTask*` when the on-disk shape is invalid;
   * the manager's `recoverOrphaned` path catches that and quarantines.
   */
  read(id: string): Promise<Task | null>;

  /**
   * Insert or replace a task. The id comes from `task.id`; callers do
   * not pass it separately. Atomic from a reader's perspective:
   * concurrent `read` calls see either the previous value or the new
   * one, never partial bytes.
   */
  save(task: Task): Promise<void>;

  /**
   * Remove the task's metadata. Idempotent: deleting a missing id is a
   * no-op. Does NOT touch agent-owned content under the task's workdir
   * (captured stderr, agent-produced files) or the runtime's own
   * per-task state — those concerns live in
   * `TaskManager.delete(id, { purge })`, not in the repository.
   */
  delete(id: string): Promise<void>;

  /**
   * Snapshot of every task this repository knows about, applying
   * filters server-side where possible. The filters mirror
   * `ListTaskOpts` from the manager surface so the manager can pass
   * them through without re-shaping.
   */
  list(opts?: ListTaskOpts): Promise<Task[]>;
}

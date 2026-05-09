import { readTaskRuntimeMetadata } from "../task-meta.js";
import type { ListTaskOpts, Task } from "../types.js";
import type { TaskRepository } from "./repository.js";

/**
 * In-memory implementation of `TaskRepository`. Useful for unit tests
 * that want to skip filesystem orchestration. Storage is plain
 * `Map<id, Task>`; no cross-process coordination (single-process by
 * definition).
 */
export class InMemoryTaskRepository implements TaskRepository {
  private readonly entries = new Map<string, Task>();

  /** Pre-seed the repository with tasks. Useful for test fixtures. */
  constructor(seed: readonly Task[] = []) {
    for (const t of seed) {
      this.entries.set(t.id, Object.freeze({ ...t }));
    }
  }

  async read(id: string): Promise<Task | null> {
    return this.entries.get(id) ?? null;
  }

  async save(task: Task): Promise<void> {
    this.entries.set(task.id, Object.freeze({ ...task }));
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async list(opts: ListTaskOpts = {}): Promise<Task[]> {
    const wantStatuses = opts.statuses ? new Set(opts.statuses) : null;
    const out: Task[] = [];
    for (const task of this.entries.values()) {
      if (opts.agent !== undefined && task.agent !== opts.agent) continue;
      if (opts.createdSince !== undefined && task.createdAt < opts.createdSince) continue;
      if (wantStatuses && !wantStatuses.has(task.status)) continue;
      if (opts.runtime !== undefined) {
        const meta = readTaskRuntimeMetadata(task);
        if (meta.runtime !== opts.runtime) continue;
      }
      out.push(task);
    }
    return out;
  }
}

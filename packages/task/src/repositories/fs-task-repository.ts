import { rm } from "node:fs/promises";
import path from "node:path";
import { readJson, safeReaddir, writeJsonAtomic } from "@emploke/storage";
import { CorruptedTaskError, InvalidTaskIdError } from "../errors.js";
import { assertValidTaskId, TASK_ID_RE } from "../ids.js";
import { readTaskRuntimeMetadata } from "../task-meta.js";
import type { ListTaskOpts, Task, TaskStatus } from "../types.js";
import type { TaskRepository } from "./repository.js";

const TASK_FILE_NAME = "task.json";
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Filesystem implementation of `TaskRepository`. Each task lives at
 * `<tasksDir>/<id>/task.json`. Deleting the task removes only that
 * file; the rest of the per-task workdir (the runtime's `session/`
 * junction, agent artifacts) is the manager's `purge` concern.
 *
 * Wire format is **flat**: `task.json` contains `{schemaVersion, ...task fields}`.
 * Earlier emploke versions used a nested `{schemaVersion, task: {...}}`
 * shape; the new flat shape mirrors session.json + workspace.json and
 * keeps the parsing path uniform across entities. Reads of the legacy
 * nested shape are NOT supported (emploke is unreleased; existing
 * task.json files from prior PRs need to be regenerated).
 */
export class FsTaskRepository implements TaskRepository {
  private readonly tasksDir: string;

  constructor(opts: { tasksDir: string }) {
    this.tasksDir = path.resolve(opts.tasksDir);
  }

  async read(id: string): Promise<Task | null> {
    if (!TASK_ID_RE.test(id)) throw new InvalidTaskIdError(id);
    const file = path.join(this.tasksDir, id, TASK_FILE_NAME);
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch (err) {
      throw new CorruptedTaskError(id, `unreadable task.json: ${(err as Error).message}`);
    }
    if (raw === null) return null;
    return parseTask(id, raw);
  }

  async save(task: Task): Promise<void> {
    assertValidTaskId(task.id);
    const file = path.join(this.tasksDir, task.id, TASK_FILE_NAME);
    // Flatten: schemaVersion + task fields all at the top level.
    const wire = { schemaVersion: CURRENT_SCHEMA_VERSION, ...task };
    await writeJsonAtomic(file, wire);
  }

  async delete(id: string): Promise<void> {
    if (!TASK_ID_RE.test(id)) return; // idempotent; no need to throw on bad id
    const file = path.join(this.tasksDir, id, TASK_FILE_NAME);
    await rm(file, { force: true });
  }

  async list(opts: ListTaskOpts = {}): Promise<Task[]> {
    const names = (await safeReaddir(this.tasksDir)).filter((n) => TASK_ID_RE.test(n));
    const out: Task[] = [];
    const wantStatuses = opts.statuses ? new Set(opts.statuses) : null;
    await Promise.all(
      names.map(async (id) => {
        let task: Task | null;
        try {
          task = await this.read(id);
        } catch {
          // Corrupted task.json — drop from list. Manager's
          // recoverOrphaned can be told to repair these later.
          return;
        }
        if (task === null) return;
        if (opts.agent !== undefined && task.agent !== opts.agent) return;
        if (opts.createdSince !== undefined && task.createdAt < opts.createdSince) return;
        if (wantStatuses && !wantStatuses.has(task.status)) return;
        if (opts.runtime !== undefined) {
          const meta = readTaskRuntimeMetadata(task);
          if (meta.runtime !== opts.runtime) return;
        }
        out.push(task);
      }),
    );
    return out;
  }
}

function parseTask(id: string, raw: unknown): Task {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CorruptedTaskError(id, "expected an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new CorruptedTaskError(id, schemaMismatchReason(obj.schemaVersion));
  }
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new CorruptedTaskError(id, "task.id must be a non-empty string");
  }
  if (typeof obj.agent !== "string") {
    throw new CorruptedTaskError(id, "task.agent must be a string");
  }
  if (typeof obj.instructions !== "string") {
    throw new CorruptedTaskError(id, "task.instructions must be a string");
  }
  if (typeof obj.status !== "string") {
    throw new CorruptedTaskError(id, "task.status must be a string");
  }
  if (typeof obj.createdAt !== "string") {
    throw new CorruptedTaskError(id, "task.createdAt must be a string");
  }
  if (!obj.metadata || typeof obj.metadata !== "object" || Array.isArray(obj.metadata)) {
    throw new CorruptedTaskError(id, "task.metadata must be an object");
  }
  // Strip schemaVersion before returning; the domain Task does not carry it.
  const { schemaVersion: _sv, ...task } = obj;
  return task as unknown as Task;
}

function schemaMismatchReason(onDisk: unknown): string {
  if (typeof onDisk === "number" && Number.isFinite(onDisk)) {
    if (onDisk > CURRENT_SCHEMA_VERSION) {
      return `task.json was written by a newer emploke (schemaVersion ${onDisk}; this server supports ${CURRENT_SCHEMA_VERSION}). Upgrade the server to read it.`;
    }
    if (onDisk < CURRENT_SCHEMA_VERSION) {
      return `task.json was written by an older emploke (schemaVersion ${onDisk}; this server supports ${CURRENT_SCHEMA_VERSION}). Migration from older versions is not yet implemented.`;
    }
  }
  return `unsupported schemaVersion: ${JSON.stringify(onDisk)}`;
}

// Suppress unused-warning for ListTaskOpts members not directly referenced
// (statuses uses Set, others use direct property access).
void (null as unknown as TaskStatus);

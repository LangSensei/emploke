import type { EntityManager } from "@mikro-orm/core";
import { type Logger, silentLogger } from "@emploke/logger";
import { CorruptedTaskError, InvalidTaskIdError } from "./errors.js";
import { TASK_ID_RE } from "./ids.js";
import { TaskRow } from "./entity.js";
import { Task } from "./task-entity.js";
import type {
  ListTaskOpts,
  TaskCancellation,
  TaskFailure,
  TaskOrigin,
  TaskStatus,
  TaskSuccess,
} from "./types.js";

export class TaskRepository {
  private readonly em: EntityManager;
  private readonly logger: Logger;

  constructor(opts: { em: EntityManager; logger?: Logger }) {
    this.em = opts.em;
    this.logger = opts.logger ?? silentLogger;
  }

  close(): void {
    // intentionally empty
  }

  async read(id: string): Promise<Task | null> {
    if (!TASK_ID_RE.test(id)) throw new InvalidTaskIdError(id);
    const row = await this.em.fork().findOne(TaskRow, { id });
    if (row === null) return null;
    return rowToTask(row);
  }

  async save(task: Task): Promise<void> {
    if (!TASK_ID_RE.test(task.id)) throw new InvalidTaskIdError(task.id);
    const em = this.em.fork();
    const existing = await em.findOne(TaskRow, { id: task.id });
    if (existing !== null) {
      Object.assign(existing, taskToRowFields(task));
      await em.persistAndFlush(existing);
    } else {
      const row = em.create(TaskRow, taskToRowFields(task));
      await em.persistAndFlush(row);
    }
  }

  async delete(id: string): Promise<void> {
    if (!TASK_ID_RE.test(id)) return;
    await this.em.fork().nativeDelete(TaskRow, { id });
  }

  async list(opts: ListTaskOpts = {}): Promise<Task[]> {
    const em = this.em.fork();
    const where: {
      agent?: string;
      runtime?: string;
      createdAt?: { $gte: string };
      status?: { $in: TaskStatus[] };
      origin?: { $in: TaskOrigin[] };
    } = {};
    if (opts.agent !== undefined) where.agent = opts.agent;
    if (opts.runtime !== undefined) where.runtime = opts.runtime;
    if (opts.createdSince !== undefined) where.createdAt = { $gte: opts.createdSince };
    if (opts.statuses && opts.statuses.length > 0) {
      where.status = { $in: [...opts.statuses] };
    }
    if (opts.origin !== undefined) {
      const origins = Array.isArray(opts.origin)
        ? [...(opts.origin as readonly TaskOrigin[])]
        : [opts.origin as TaskOrigin];
      if (origins.length > 0) where.origin = { $in: origins };
    }
    const rows = await em.find(TaskRow, where);
    const out: Task[] = [];
    for (const row of rows) {
      try {
        out.push(rowToTask(row));
      } catch (err) {
        this.logger.warn(
          { taskId: row.id ?? null, reason: err instanceof Error ? err.message : String(err) },
          "tasks: skipping corrupted task row",
        );
      }
    }
    return out;
  }
}

function taskToRowFields(task: Task): {
  id: string;
  agent: string;
  runtime: string | null;
  status: TaskStatus;
  brief: string;
  details: string | null;
  origin: TaskOrigin;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  success: string | null;
  failure: string | null;
  cancellation: string | null;
  metadata: string;
} {
  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  let runtime: string | null = null;
  let metaForJson: Record<string, unknown> = meta;
  if (typeof meta.runtime === "string") {
    runtime = meta.runtime;
    const { runtime: _r, ...rest } = meta;
    metaForJson = rest;
  }
  return {
    id: task.id,
    agent: task.agent,
    runtime,
    status: task.status,
    brief: task.brief,
    details: task.details ?? null,
    origin: task.origin,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? null,
    success: task.success !== undefined ? JSON.stringify(task.success) : null,
    failure: task.failure !== undefined ? JSON.stringify(task.failure) : null,
    cancellation: task.cancellation !== undefined ? JSON.stringify(task.cancellation) : null,
    metadata: JSON.stringify(metaForJson),
  };
}

function rowToTask(row: TaskRow): Task {
  let metaParsed: unknown;
  try {
    metaParsed = JSON.parse(row.metadata);
  } catch (err) {
    throw new CorruptedTaskError(
      row.id,
      `task.metadata is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (metaParsed === null || typeof metaParsed !== "object" || Array.isArray(metaParsed)) {
    throw new CorruptedTaskError(row.id, "task.metadata must decode to an object");
  }
  let metadata: Record<string, unknown> = metaParsed as Record<string, unknown>;
  if (row.runtime !== null) {
    metadata = { ...metadata, runtime: row.runtime };
  }

  const success = parseJsonColumn<TaskSuccess>(row.id, "success", row.success);
  const failure = parseJsonColumn<TaskFailure>(row.id, "failure", row.failure);
  const cancellation = parseJsonColumn<TaskCancellation>(row.id, "cancellation", row.cancellation);

  return Task.fromStored({
    id: row.id,
    agent: row.agent,
    brief: row.brief,
    ...(row.details !== null ? { details: row.details } : {}),
    origin: row.origin,
    status: row.status,
    metadata,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    ...(row.endedAt !== null ? { endedAt: row.endedAt } : {}),
    ...(success !== undefined ? { success } : {}),
    ...(failure !== undefined ? { failure } : {}),
    ...(cancellation !== undefined ? { cancellation } : {}),
  });
}

function parseJsonColumn<T>(id: string, name: string, raw: string | null): T | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptedTaskError(id, `task.${name} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorruptedTaskError(id, `task.${name} must decode to an object`);
  }
  return parsed as T;
}

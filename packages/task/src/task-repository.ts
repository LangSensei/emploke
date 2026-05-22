import { and, eq, gte, inArray, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";
import { CorruptedTaskError, InvalidTaskIdError } from "./errors.js";
import type * as schema from "./schema.js";
import { type TaskRow, tasks } from "./schema.js";
import { TaskEntity } from "./task-entity.js";
import type {
  ListTaskOpts,
  TaskCancellation,
  TaskFailure,
  TaskOrigin,
  TaskStatus,
  TaskSuccess,
} from "./types.js";
import { TASK_ID_RE } from "./validate.js";

const silentLogger: Logger = pino({ level: "silent" });

type Db = BetterSQLite3Database<typeof schema>;

export class TaskRepository {
  private readonly db: Db;
  private readonly logger: Logger;

  constructor(opts: { db: Db; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
  }

  async read(id: string): Promise<TaskEntity | null> {
    if (!TASK_ID_RE.test(id)) throw new InvalidTaskIdError(id);
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (row === undefined) return null;
    return rowToTask(row);
  }

  async save(task: TaskEntity): Promise<void> {
    if (!TASK_ID_RE.test(task.id)) throw new InvalidTaskIdError(task.id);
    const fields = taskToRowFields(task);
    // Upsert in one statement via SQLite's `ON CONFLICT DO UPDATE`.
    // Previous shape was `select-then-update-or-insert`, two
    // round-trips with a TOCTOU window: a concurrent `delete(id)`
    // between the SELECT and the UPDATE landed the wrong branch
    // (would UPDATE 0 rows silently). better-sqlite3 is synchronous
    // in-process so a real race needed a concurrent SQL connection,
    // but the upsert is both simpler and removes the window.
    this.db
      .insert(tasks)
      .values(fields)
      .onConflictDoUpdate({ target: tasks.id, set: fields })
      .run();
  }

  async delete(id: string): Promise<void> {
    // Fail-loud on invalid id, matching `read()` / `save()` —
    // silently returning meant a `DELETE /tasks/:tid` with a typo
    // would 204 to the dashboard instead of surfacing the error.
    if (!TASK_ID_RE.test(id)) throw new InvalidTaskIdError(id);
    this.db.delete(tasks).where(eq(tasks.id, id)).run();
  }

  async list(opts: ListTaskOpts = {}): Promise<TaskEntity[]> {
    const filters: SQL[] = [];
    if (opts.agent !== undefined) filters.push(eq(tasks.agent, opts.agent));
    if (opts.runtime !== undefined) filters.push(eq(tasks.runtime, opts.runtime));
    if (opts.createdSince !== undefined) filters.push(gte(tasks.createdAt, opts.createdSince));
    if (opts.statuses && opts.statuses.length > 0) {
      filters.push(inArray(tasks.status, [...opts.statuses]));
    }
    if (opts.origin !== undefined) {
      const origins: TaskOrigin[] = Array.isArray(opts.origin)
        ? [...(opts.origin as readonly TaskOrigin[])]
        : [opts.origin as TaskOrigin];
      if (origins.length > 0) filters.push(inArray(tasks.origin, origins));
    }
    const query = this.db.select().from(tasks);
    const rows = filters.length > 0 ? query.where(and(...filters)).all() : query.all();
    const out: TaskEntity[] = [];
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

function taskToRowFields(task: TaskEntity): {
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

function rowToTask(row: TaskRow): TaskEntity {
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

  return TaskEntity.fromStored({
    id: row.id,
    agent: row.agent,
    brief: row.brief,
    ...(row.details !== null ? { details: row.details } : {}),
    origin: row.origin as TaskOrigin,
    status: row.status as TaskStatus,
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

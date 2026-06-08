import { and, eq, gte, inArray, notInArray, type SQL, sql } from "drizzle-orm";
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
import { TERMINAL_TASK_STATUSES } from "./types.js";
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
    const task = rowToTask(row);
    if (task.id !== id) {
      // Defensive: row's stored id disagrees with the primary-key id
      // we just selected by. Under SQLite this should be impossible
      // (the PK constraint on `tasks.id` plus the `WHERE tasks.id = id`
      // filter together rule it out), so a fire here means either the
      // schema changed under our feet or someone tampered with the DB
      // out-of-band. We surface a warn and trust the caller's id so the
      // dashboard doesn't silently route a task under the wrong key.
      this.logger.warn(
        { taskId: id, persistedId: task.id },
        "tasks: id mismatch between dir and persisted row",
      );
    }
    return task;
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
    if (opts.scheduleId !== undefined) {
      // Functional predicate: `metadata` is a JSON text column, and
      // `scheduleId` lives at `$.scheduleId`. The companion functional
      // index `tasks_schedule_id_idx` makes this O(log n) when the
      // optimiser can prove the WHERE shape lines up — combine with
      // `origin='schedule'` in the same query to engage it.
      filters.push(sql`json_extract(${tasks.metadata}, '$.scheduleId') = ${opts.scheduleId}`);
    }
    const query = this.db.select().from(tasks);
    const rows = filters.length > 0 ? query.where(and(...filters)).all() : query.all();
    const out: TaskEntity[] = [];
    for (const row of rows) {
      try {
        out.push(rowToTask(row));
      } catch (err) {
        this.logger.warn({ taskId: row.id ?? null, err }, "tasks: skipping corrupted task row");
      }
    }
    return out;
  }

  /**
   * True if any task with `origin='schedule'` and
   * `metadata.scheduleId === scheduleId` is non-terminal (i.e. status
   * is not in {@link TERMINAL_TASK_STATUSES}). Backed by the
   * `tasks_schedule_id_idx` functional index; the partial WHERE on
   * the index matches the `origin = 'schedule'` predicate here, so
   * the planner can satisfy the query from the index without a full
   * table scan.
   *
   * Non-terminal (rather than `status = 'running'`) is the right
   * semantic for both the scheduler's concurrency=1 check and the
   * schedule-delete guard: a future non-terminal status (e.g.
   * `"queued"`) would otherwise silently slip past both checks.
   */
  async hasInFlightForSchedule(scheduleId: string): Promise<boolean> {
    const row = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.origin, "schedule"),
          notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
          sql`json_extract(${tasks.metadata}, '$.scheduleId') = ${scheduleId}`,
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  /**
   * True if any task with `origin='workflow'` and
   * `metadata.workflowNodeId === nodeId` is non-terminal (i.e. status
   * is not in {@link TERMINAL_TASK_STATUSES}). Used by the workflow
   * engine's `hasInFlightForNode` reverse-lookup for worker nodes
   * (see `packages/api/src/wiring/workflow-task-runner.ts`).
   *
   * Unlike {@link hasInFlightForSchedule} there is no functional
   * index on `metadata.workflowNodeId`; the planner falls back to
   * filtering by `origin='workflow'` first (still index-eligible
   * via the same row's `origin` column path) and applying the
   * `json_extract` predicate on the matched rows only. Workflow
   * worker volume is currently low enough that a functional index
   * is not yet worth the migration cost.
   *
   * `workflowNodeId` is the canonical metadata key per
   * `packages/workflow/src/types.ts:222` (substrate-side denorm of
   * unit-of-work ids is explicitly forbidden; reverse lookup goes
   * through this metadata key).
   */
  async hasInFlightForWorkflowNode(nodeId: string): Promise<boolean> {
    const row = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.origin, "workflow"),
          notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
          sql`json_extract(${tasks.metadata}, '$.workflowNodeId') = ${nodeId}`,
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  /**
   * List non-terminal tasks with `origin='workflow'` and
   * `metadata.workflowNodeId === nodeId`. Used by the worker
   * runner's `cancel(nodeId)` reverse-lookup to find which task(s)
   * to cancel.
   *
   * Returns full entities (not just ids) because the caller needs
   * `task.id` for `tasks.cancel(...)` and the per-row error in
   * `rowToTask` is already handled with warn-and-skip.
   */
  async listInFlightForWorkflowNode(nodeId: string): Promise<TaskEntity[]> {
    const rows = this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.origin, "workflow"),
          notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
          sql`json_extract(${tasks.metadata}, '$.workflowNodeId') = ${nodeId}`,
        ),
      )
      .all();
    const out: TaskEntity[] = [];
    for (const row of rows) {
      try {
        out.push(rowToTask(row));
      } catch (err) {
        this.logger.warn(
          { taskId: row.id ?? null, err },
          "tasks: skipping corrupted task row in listInFlightForWorkflowNode",
        );
      }
    }
    return out;
  }

  /**
   * Bulk-delete every TERMINAL task with `origin='schedule'` and
   * `metadata.scheduleId === scheduleId`. Returns the deleted entities
   * so the caller can enqueue per-task background work (e.g.
   * `TaskService.scheduleBackgroundPurge`).
   *
   * Two-step (SELECT → DELETE) instead of `RETURNING` so that we can
   * map rows to entities BEFORE removing them: if a corrupted row
   * makes `rowToTask` throw, we warn-and-skip (matching `list()`'s
   * behaviour) and still drop the DB rows in the same SQL statement.
   * `RETURNING` would leave us with the rows already gone but no
   * recovery if mapping threw partway.
   *
   * The DELETE uses the SAME predicate as the SELECT (not an `IN (id,
   * id, …)` list) so we sidestep SQLite's bound-variable limit at
   * large N — a schedule with thousands of historical fires is
   * possible.
   *
   * Race window: between the SELECT and the DELETE another writer
   * could have inserted or transitioned rows. In practice the caller
   * (`ScheduleService.delete`) has already cancelled the schedule's
   * timer and rejected the call if `hasInFlightForSchedule` returned
   * true — so the only realistic insertion path is a concurrent
   * manual `ScheduleService.run()`, which the caller separately
   * defends against with a second `hasInFlightForSchedule` check
   * after this method returns.
   */
  async deleteTerminalForSchedule(scheduleId: string): Promise<TaskEntity[]> {
    const predicate = and(
      eq(tasks.origin, "schedule"),
      inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      sql`json_extract(${tasks.metadata}, '$.scheduleId') = ${scheduleId}`,
    );
    const rows = this.db.select().from(tasks).where(predicate).all();
    if (rows.length === 0) return [];
    const entities: TaskEntity[] = [];
    for (const row of rows) {
      try {
        entities.push(rowToTask(row));
      } catch (err) {
        this.logger.warn(
          { taskId: row.id ?? null, err },
          "tasks: skipping corrupted task row during deleteTerminalForSchedule",
        );
      }
    }
    this.db.delete(tasks).where(predicate).run();
    return entities;
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
      `task.metadata is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
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
    throw new CorruptedTaskError(
      id,
      `task.${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorruptedTaskError(id, `task.${name} must decode to an object`);
  }
  return parsed as T;
}

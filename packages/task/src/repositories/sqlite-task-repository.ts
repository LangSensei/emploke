import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { CorruptedTaskError, InvalidTaskIdError } from "../errors.js";
import { TASK_ID_RE } from "../ids.js";
import { Task } from "../task-entity.js";
import type {
  ListTaskOpts,
  TaskCancellation,
  TaskFailure,
  TaskOrigin,
  TaskStatus,
  TaskSuccess,
} from "../types.js";
import type { TaskRepository } from "./repository.js";

/**
 * Schema version for the task pkg's slice of the shared per-workspace
 * `workspace.db`. Stored in `schema_meta(pkg='task')`.
 *
 * v4 (issue #119): collapsed the 5 flat `failure_*` / `cancellation_*`
 * / `result_output` columns into 3 mutually-exclusive JSON columns
 * (`success` / `failure` / `cancellation`), normalised the status enum
 * to all-adjective form, added the first-class `origin` column, and
 * tightened `started_at` to `NOT NULL`. The table-swap migration lives
 * in `../migrations/v3-to-v4.ts`.
 */
const TASK_PKG_SCHEMA_VERSION = 4;

interface TaskRow {
  id: string;
  agent: string;
  runtime: string | null;
  status: string;
  brief: string;
  details: string | null;
  origin: string;
  created_at: string;
  started_at: string;
  ended_at: string | null;
  /** JSON-encoded {@link TaskSuccess}; populated only when status='succeeded'. */
  success: string | null;
  /** JSON-encoded {@link TaskFailure}; populated only when status='failed'. */
  failure: string | null;
  /** JSON-encoded {@link TaskCancellation}; populated only when status='cancelled'. */
  cancellation: string | null;
  metadata: string;
}

/**
 * SQLite-backed `TaskRepository` (v4 schema; see {@link TASK_PKG_SCHEMA_VERSION}).
 *
 * Each task's metadata lives in a row of the `tasks` table inside the
 * shared per-workspace database (`<workspace>/workspace.db`). The
 * task's workdir (`<workspace>/tasks/<id>/`) is not owned by this
 * repository.
 *
 * `Task.metadata.runtime` is promoted to a first-class column for
 * indexed filtering; every other key in `metadata` round-trips
 * verbatim through the JSON `metadata` column.
 *
 * Row-to-entity decoding is delegated to {@link Task.fromStored}: the
 * repository is the source of bytes, the entity is the source of
 * validation. Local helper `parseRow` only handles concerns SQLite
 * exposes (`metadata` is a JSON string column, `runtime` is promoted
 * out of the JSON bag, the three terminal-payload JSON columns are
 * parsed into typed unions) before handing the rest to the entity
 * factory.
 */
export class SqliteTaskRepository implements TaskRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  constructor(opts: { db: DatabaseSync; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    this.ensureSchema();
  }

  /** No-op — the connection is owned by the caller. */
  close(): void {
    // intentionally empty
  }

  async read(id: string): Promise<Task | null> {
    if (!TASK_ID_RE.test(id)) throw new InvalidTaskIdError(id);
    const row = this.db
      .prepare(
        `SELECT id, agent, runtime, status, brief, details, origin, created_at, started_at,
                ended_at, success, failure, cancellation, metadata
         FROM tasks WHERE id = ?`,
      )
      .get(id) as TaskRow | undefined;
    if (row === undefined) return null;
    return parseRow(id, row);
  }

  async save(task: Task): Promise<void> {
    if (!TASK_ID_RE.test(task.id)) throw new InvalidTaskIdError(task.id);
    const meta = task.metadata ?? {};
    let runtime: string | null = null;
    let metaForJson: Record<string, unknown> = meta as Record<string, unknown>;
    if (typeof meta.runtime === "string") {
      runtime = meta.runtime;
      const { runtime: _r, ...rest } = meta as Record<string, unknown>;
      metaForJson = rest;
    }
    const metaJson = JSON.stringify(metaForJson);

    const successJson = task.success !== undefined ? JSON.stringify(task.success) : null;
    const failureJson = task.failure !== undefined ? JSON.stringify(task.failure) : null;
    const cancellationJson =
      task.cancellation !== undefined ? JSON.stringify(task.cancellation) : null;

    this.db
      .prepare(
        `INSERT INTO tasks (id, agent, runtime, status, brief, details, origin, created_at,
                            started_at, ended_at, success, failure, cancellation, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent = excluded.agent,
           runtime = excluded.runtime,
           status = excluded.status,
           brief = excluded.brief,
           details = excluded.details,
           origin = excluded.origin,
           created_at = excluded.created_at,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           success = excluded.success,
           failure = excluded.failure,
           cancellation = excluded.cancellation,
           metadata = excluded.metadata`,
      )
      .run(
        task.id,
        task.agent,
        runtime,
        task.status,
        task.brief,
        task.details ?? null,
        task.origin,
        task.createdAt,
        task.startedAt,
        task.endedAt ?? null,
        successJson,
        failureJson,
        cancellationJson,
        metaJson,
      );
  }

  async delete(id: string): Promise<void> {
    if (!TASK_ID_RE.test(id)) return;
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  async list(opts: ListTaskOpts = {}): Promise<Task[]> {
    const where: string[] = [];
    const params: (string | null)[] = [];
    if (opts.agent !== undefined) {
      where.push("agent = ?");
      params.push(opts.agent);
    }
    if (opts.runtime !== undefined) {
      where.push("runtime = ?");
      params.push(opts.runtime);
    }
    if (opts.createdSince !== undefined) {
      where.push("created_at >= ?");
      params.push(opts.createdSince);
    }
    if (opts.statuses && opts.statuses.length > 0) {
      const placeholders = opts.statuses.map(() => "?").join(", ");
      where.push(`status IN (${placeholders})`);
      params.push(...opts.statuses);
    }
    if (opts.origin !== undefined) {
      const origins = Array.isArray(opts.origin)
        ? (opts.origin as readonly TaskOrigin[])
        : [opts.origin as TaskOrigin];
      if (origins.length > 0) {
        const placeholders = origins.map(() => "?").join(", ");
        where.push(`origin IN (${placeholders})`);
        params.push(...origins);
      }
    }
    let sql = `SELECT id, agent, runtime, status, brief, details, origin, created_at, started_at,
                      ended_at, success, failure, cancellation, metadata FROM tasks`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    const rows = this.db.prepare(sql).all(...params) as unknown as TaskRow[];
    const out: Task[] = [];
    for (const row of rows) {
      try {
        out.push(parseRow(row.id, row));
      } catch (err) {
        this.logger.warn(
          {
            taskId: row.id ?? null,
            reason: err instanceof Error ? err.message : String(err),
          },
          "tasks: skipping corrupted task row",
        );
      }
    }
    return out;
  }

  private ensureSchema(): void {
    // Post-issue-#123: the MigrationCoordinator owns DDL. This
    // repository's job is to assert the post-condition — a
    // `schema_meta` row for the `task` pkg at HEAD.
    let existing: { version: number } | undefined;
    try {
      existing = this.db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as
        | { version: number }
        | undefined;
    } catch {
      throw new SchemaMetaNotBootstrappedError("task");
    }
    if (existing === undefined) {
      throw new SchemaMetaNotBootstrappedError("task");
    }
    if (existing.version !== TASK_PKG_SCHEMA_VERSION) {
      throw new SchemaMetaMismatchError("task", existing.version, TASK_PKG_SCHEMA_VERSION);
    }
  }
}

/**
 * Decode a v4 `tasks` row into a {@link Task} entity. The repository is
 * the source of bytes; {@link Task.fromStored} is the source of
 * validation. This helper only handles concerns SQLite exposes:
 *   - JSON-encoded columns (`metadata`, `success`, `failure`,
 *     `cancellation`) must be parsed before being handed to typed code;
 *   - the `runtime` value is promoted out of `metadata` at save time
 *     and folded back in here so the entity sees the same shape
 *     callers passed in originally.
 */
function parseRow(id: string, row: TaskRow): Task {
  let metaParsed: unknown;
  try {
    metaParsed = JSON.parse(row.metadata);
  } catch (err) {
    throw new CorruptedTaskError(id, `task.metadata is not valid JSON: ${(err as Error).message}`);
  }
  if (metaParsed === null || typeof metaParsed !== "object" || Array.isArray(metaParsed)) {
    throw new CorruptedTaskError(id, "task.metadata must decode to an object");
  }
  let metadata: Record<string, unknown> = metaParsed as Record<string, unknown>;
  if (row.runtime !== null) {
    metadata = { ...metadata, runtime: row.runtime };
  }

  const success = parseJsonColumn<TaskSuccess>(id, "success", row.success);
  const failure = parseJsonColumn<TaskFailure>(id, "failure", row.failure);
  const cancellation = parseJsonColumn<TaskCancellation>(id, "cancellation", row.cancellation);

  return Task.fromStored({
    id,
    agent: row.agent,
    brief: row.brief,
    ...(row.details !== null ? { details: row.details } : {}),
    origin: row.origin as TaskOrigin,
    status: row.status as TaskStatus,
    metadata,
    createdAt: row.created_at,
    startedAt: row.started_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
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

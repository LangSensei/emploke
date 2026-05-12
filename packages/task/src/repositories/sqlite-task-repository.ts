import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { CorruptedTaskError, InvalidTaskIdError } from "../errors.js";
import { TASK_ID_RE } from "../ids.js";
import type { ListTaskOpts, Task, TaskStatus } from "../types.js";
import type { TaskRepository } from "./repository.js";

/**
 * Current on-disk schema version for `tasks.db`.
 *
 * Bump when an existing column is removed, renamed, or its semantics
 * change in a way an older server cannot ignore. Mismatch behaviour
 * mirrors `@emploke/workspace`'s policy: refuse to open with a
 * direction-aware message.
 */
const CURRENT_SCHEMA_VERSION = 1;

/** Closed set of valid task statuses; used to validate rows on read. */
const VALID_STATUSES = new Set<TaskStatus>([
  "not_started",
  "running",
  "success",
  "failure",
  "cancelled",
]);

interface TaskRow {
  id: string;
  agent: string;
  runtime: string | null;
  status: string;
  instructions: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  result_output: string | null;
  failure_error: string | null;
  metadata: string;
}

/**
 * SQLite-backed `TaskRepository`. Each task's metadata lives in a row
 * of the `tasks` table inside `<tasksDir>/tasks.db`. The task's workdir
 * (`<tasksDir>/<id>/`) — agent artifacts, the runtime's `session/`
 * junction, the captured `stderr.log` — is **not** owned by this
 * repository; it stays a plain directory tree on disk.
 *
 * ## `Task.metadata` handling
 *
 * `Task.metadata` is an open-shape `Record<string, unknown>`. We promote
 * one well-known field — `runtime` — to a first-class column so it can
 * be indexed (used by `ListTaskOpts.runtime` and the dashboard's
 * runtime filter). Every other key in `metadata` is stored verbatim in
 * the `metadata` JSON column.
 *
 * On `read`, the column value is re-injected into the returned
 * `task.metadata.runtime` so consumers (notably `readTaskRuntimeMetadata`
 * in `task-meta.ts`) see the same `Task` shape they always did. The
 * column promotion is a storage-layer detail; the public `Task` type
 * is unchanged.
 *
 * Defense-in-depth: every public method validates `id` against
 * `TASK_ID_RE`. SQLite parameter binding makes injection harmless, but
 * the validation makes "this is the tasks namespace, not arbitrary
 * keys" an explicit precondition.
 *
 * Concurrency: WAL + SQLite's internal serialisation. Per-id writes
 * don't need cross-process locking.
 */
export class SqliteTaskRepository implements TaskRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  /**
   * Open or create a tasks database at `dbPath`.
   *
   * Pass `":memory:"` for tests. The parent directory of `dbPath` is
   * created recursively if it doesn't already exist (no-op for
   * `:memory:`).
   *
   * `opts.logger` (optional) receives `warn` when `list()` drops a row
   * that fails validation — the manager passes its own logger here so
   * operators see per-row corruption without `list()` failing.
   */
  constructor(dbPath: string, opts?: { logger?: Logger }) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.logger = opts?.logger ?? silentLogger;
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.checkOrCreateSchema();
    } catch (err) {
      // Don't leak the DB handle if construction fails — on Windows
      // a leaked WAL handle blocks the test cleanup `rm` with EBUSY.
      try {
        this.db.close();
      } catch {
        // best-effort
      }
      throw err;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed; idempotent.
    }
  }

  async read(id: string): Promise<Task | null> {
    if (!TASK_ID_RE.test(id)) throw new InvalidTaskIdError(id);
    const row = this.db
      .prepare(
        `SELECT id, agent, runtime, status, instructions, created_at, started_at, ended_at,
                result_output, failure_error, metadata
         FROM tasks WHERE id = ?`,
      )
      .get(id) as TaskRow | undefined;
    if (row === undefined) return null;
    return rowToTask(id, row);
  }

  async save(task: Task): Promise<void> {
    if (!TASK_ID_RE.test(task.id)) throw new InvalidTaskIdError(task.id);
    const meta = task.metadata ?? {};
    // Only promote `runtime` to its own column when it's a string
    // (the Task type permits `unknown` here). When it's anything else
    // (number, object, undefined explicitly set, ...), keep it inside
    // the JSON `metadata` blob so `read()` round-trips the original
    // value verbatim — silently dropping it would violate the
    // "open-shape keys round-trip verbatim" guarantee `Task.metadata`
    // makes to runtime adapters.
    let runtime: string | null = null;
    let metaForJson: Record<string, unknown> = meta as Record<string, unknown>;
    if (typeof meta.runtime === "string") {
      runtime = meta.runtime;
      const { runtime: _r, ...rest } = meta as Record<string, unknown>;
      metaForJson = rest;
    }
    const metaJson = JSON.stringify(metaForJson);
    this.db
      .prepare(
        `INSERT INTO tasks (id, agent, runtime, status, instructions, created_at, started_at,
                            ended_at, result_output, failure_error, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent = excluded.agent,
           runtime = excluded.runtime,
           status = excluded.status,
           instructions = excluded.instructions,
           created_at = excluded.created_at,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           result_output = excluded.result_output,
           failure_error = excluded.failure_error,
           metadata = excluded.metadata`,
      )
      .run(
        task.id,
        task.agent,
        runtime,
        task.status,
        task.instructions,
        task.createdAt,
        task.startedAt ?? null,
        task.endedAt ?? null,
        task.result?.output ?? null,
        task.failure?.error ?? null,
        metaJson,
      );
  }

  async delete(id: string): Promise<void> {
    // Idempotent on bad ids — matches the old FsTaskRepository.delete.
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
    let sql = `SELECT id, agent, runtime, status, instructions, created_at, started_at, ended_at,
                      result_output, failure_error, metadata FROM tasks`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    const rows = this.db.prepare(sql).all(...params) as unknown as TaskRow[];
    const out: Task[] = [];
    for (const row of rows) {
      try {
        out.push(rowToTask(row.id, row));
      } catch (err) {
        // Corrupted row — drop from list. Matches the old
        // FsTaskRepository.list behaviour. We warn via the injected
        // logger so operators can see the bad row without `list`
        // itself failing — the manager hooks its own logger here.
        this.logger.warn("tasks: skipping corrupted task.json", {
          taskId: row.id ?? null,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  // ─── schema management ──────────────────────────────────────

  private checkOrCreateSchema(): void {
    const meta = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
      .get() as { name: string } | undefined;
    if (meta === undefined) {
      this.createSchema();
      return;
    }
    const row = this.db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
      | { version: number }
      | undefined;
    if (row === undefined) {
      throw new Error(
        "tasks.db: schema_meta table exists but is empty (db is corrupted; remove it and restart)",
      );
    }
    if (row.version === CURRENT_SCHEMA_VERSION) return;
    if (row.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `tasks.db was written by a newer emploke (schema v${row.version}; this server supports v${CURRENT_SCHEMA_VERSION}). Upgrade the server to read it.`,
      );
    }
    throw new Error(
      `tasks.db was written by an older emploke (schema v${row.version}; this server supports v${CURRENT_SCHEMA_VERSION}). Migration from older versions is not yet implemented.`,
    );
  }

  private createSchema(): void {
    // Bootstrap inside a transaction so a crash mid-DDL leaves an empty
    // db (caller treats that as "fresh, recreate") rather than a
    // half-built one (schema_meta present but `tasks` missing → reads
    // fail confusingly). `IF NOT EXISTS` + `INSERT OR IGNORE` makes
    // the bootstrap race-safe across concurrent first-opens of the
    // same dbPath (rare in practice — one server per workspace — but
    // free defence).
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          version INTEGER NOT NULL PRIMARY KEY CHECK (version > 0)
        );
        INSERT OR IGNORE INTO schema_meta (version) VALUES (${CURRENT_SCHEMA_VERSION});
        CREATE TABLE IF NOT EXISTS tasks (
          id              TEXT PRIMARY KEY,
          agent           TEXT NOT NULL,
          runtime         TEXT,
          status          TEXT NOT NULL,
          instructions    TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          started_at      TEXT,
          ended_at        TEXT,
          result_output   TEXT,
          failure_error   TEXT,
          metadata        TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS tasks_status_idx     ON tasks(status);
        CREATE INDEX IF NOT EXISTS tasks_runtime_idx    ON tasks(runtime);
        CREATE INDEX IF NOT EXISTS tasks_agent_idx      ON tasks(agent);
        CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at);
      `);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function rowToTask(id: string, row: TaskRow): Task {
  if (typeof row.agent !== "string") {
    throw new CorruptedTaskError(id, "task.agent must be a string");
  }
  if (typeof row.instructions !== "string") {
    throw new CorruptedTaskError(id, "task.instructions must be a string");
  }
  if (typeof row.status !== "string" || !VALID_STATUSES.has(row.status as TaskStatus)) {
    throw new CorruptedTaskError(
      id,
      `task.status must be one of: ${[...VALID_STATUSES].join(", ")}`,
    );
  }
  if (typeof row.created_at !== "string") {
    throw new CorruptedTaskError(id, "task.created_at must be a string");
  }
  let metaParsed: Record<string, unknown>;
  try {
    const v = JSON.parse(row.metadata) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error("expected an object");
    }
    metaParsed = v as Record<string, unknown>;
  } catch (err) {
    throw new CorruptedTaskError(id, `task.metadata is not valid JSON: ${(err as Error).message}`);
  }
  // Re-inject the column-promoted runtime so the public Task shape is
  // unchanged. Storage-level promotion is invisible to consumers.
  if (row.runtime !== null) {
    metaParsed = { ...metaParsed, runtime: row.runtime };
  }
  const task: Task = {
    id,
    agent: row.agent,
    instructions: row.instructions,
    status: row.status as TaskStatus,
    metadata: metaParsed,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(row.result_output !== null ? { result: { output: row.result_output } } : {}),
    ...(row.failure_error !== null ? { failure: { error: row.failure_error } } : {}),
  };
  return task;
}

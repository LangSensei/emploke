import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { CorruptedTaskError, InvalidTaskIdError } from "../errors.js";
import { TASK_ID_RE } from "../ids.js";
import { Task } from "../task-entity.js";
import type { ListTaskOpts, TaskStatus } from "../types.js";
import type { TaskRepository } from "./repository.js";

const TASK_PKG_SCHEMA_VERSION = 1;

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
 * of the `tasks` table inside the **shared per-workspace database**
 * (`<workspace>/workspace.db`). The task's workdir
 * (`<workspace>/tasks/<id>/`) — agent artifacts and the captured
 * `stderr.log` — is **not** owned by this repository; it stays a plain
 * directory tree on disk.
 *
 * The constructor takes an already-opened `DatabaseSync`. The server
 * shares one connection across every per-workspace repository
 * (task / session / catalog / workflow), so cross-entity JOINs and
 * atomic multi-table transactions are cheap and the file handle count
 * per workspace stays at one.
 *
 * `Task.metadata.runtime` is promoted to a first-class column for
 * indexed filtering; every other key in `metadata` round-trips
 * verbatim through the JSON `metadata` column.
 *
 * Row-to-entity decoding is delegated to {@link Task.fromStored}: the
 * repository is the source of bytes, the entity is the source of
 * validation. Local helper `parseRow` only handles concerns SQLite
 * exposes (`metadata` is a JSON string column, `runtime` is promoted
 * out of the JSON bag) before handing the rest to the entity factory.
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
        `SELECT id, agent, runtime, status, instructions, created_at, started_at, ended_at,
                result_output, failure_error, metadata
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        pkg     TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0)
      );
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
    const existing = this.db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as
      | { version: number }
      | undefined;
    if (existing === undefined) {
      this.db
        .prepare("INSERT INTO schema_meta (pkg, version) VALUES (?, ?)")
        .run("task", TASK_PKG_SCHEMA_VERSION);
      return;
    }
    if (existing.version === TASK_PKG_SCHEMA_VERSION) return;
    throw new Error(
      `task pkg schema mismatch: db has v${existing.version}, server supports v${TASK_PKG_SCHEMA_VERSION}.`,
    );
  }
}

/**
 * Decode a `tasks` row into a {@link Task} entity. Storage-shape
 * concerns are handled here:
 *   - the `metadata` column is JSON-encoded text, so this function
 *     must parse it *and* reject syntactically-invalid JSON or
 *     non-object roots before handing the value to the entity factory
 *     (which only knows about typed JS values, not the JSON wire
 *     format we chose for this column);
 *   - the `runtime` value is a promoted column extracted from the
 *     metadata bag at save time; we re-fold it back into the bag here
 *     so the entity sees the same shape callers passed in originally.
 *
 * Everything else (id format, status enum, ISO timestamps,
 * metadata-is-an-object) is validated by {@link Task.fromStored}.
 */
function parseRow(id: string, row: TaskRow): Task {
  let metaParsed: unknown;
  try {
    metaParsed = JSON.parse(row.metadata);
  } catch (err) {
    // Storage-side concern: the wire format for the metadata column is
    // JSON, and a parse failure means the column was tampered with or
    // bit-rot. Surface as a typed corruption so list() can skip + warn
    // and read() can 5xx with a meaningful reason.
    throw new CorruptedTaskError(id, `task.metadata is not valid JSON: ${(err as Error).message}`);
  }
  if (metaParsed === null || typeof metaParsed !== "object" || Array.isArray(metaParsed)) {
    throw new CorruptedTaskError(id, "task.metadata must decode to an object");
  }
  let metadata: Record<string, unknown> = metaParsed as Record<string, unknown>;
  if (row.runtime !== null) {
    metadata = { ...metadata, runtime: row.runtime };
  }
  return Task.fromStored({
    id,
    agent: row.agent,
    instructions: row.instructions,
    status: row.status as TaskStatus,
    metadata,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(row.result_output !== null ? { result: { output: row.result_output } } : {}),
    ...(row.failure_error !== null ? { failure: { error: row.failure_error } } : {}),
  });
}

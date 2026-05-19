import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { CorruptedTaskError, InvalidTaskIdError } from "../errors.js";
import { TASK_ID_RE } from "../ids.js";
import { Task } from "../task-entity.js";
import type { ListTaskOpts, TaskCancellation, TaskFailure, TaskStatus } from "../types.js";
import type { TaskRepository } from "./repository.js";

/**
 * Bumped from 1 → 2 for the `instructions` → `brief`+`details` split
 * (pre-1.0 hard cut; see PR refactor/task-brief-details). Older v1
 * databases are migrated in-place by {@link migrateV1ToV2}; the
 * `brief` value is back-filled from the first 200 chars of the
 * legacy `instructions` column (best-effort heuristic — the v1
 * column had no length cap so longer values truncate at the v2
 * contract). The full original text is preserved verbatim in the
 * new `details` column.
 *
 * Bumped from 2 → 3 for ADR-001's structured TaskFailure /
 * TaskCancellation discriminated unions. The migration is purely
 * additive (`ALTER TABLE ADD COLUMN` for five nullable columns —
 * `failure_kind`, `failure_exit_code`, `failure_signal`,
 * `cancellation_kind`, `cancellation_message`); see
 * {@link migrateV2ToV3}. Legacy `failure_error`-only rows are
 * synthesised at read time as `{ kind: 'internal', message: <text> }`
 * with a one-line warning so operators can spot the legacy pattern.
 */
const TASK_PKG_SCHEMA_VERSION = 3;

interface TaskRow {
  id: string;
  agent: string;
  runtime: string | null;
  status: string;
  brief: string;
  details: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  result_output: string | null;
  /**
   * Reused as the storage column for `TaskFailure.message` post-ADR-001.
   * For rows written before v3 this is the only failure-related column
   * populated, and the read path synthesises a typed
   * `{ kind: 'internal', message: failure_error }` value with a
   * one-line warning.
   */
  failure_error: string | null;
  /**
   * Discriminator for `TaskFailure`. NULL for legacy v2 rows; the
   * read path synthesises `{ kind: 'internal', ... }` when this is
   * NULL but `failure_error` is populated.
   */
  failure_kind: string | null;
  /** Populated only when `failure_kind === 'exited'`. */
  failure_exit_code: number | null;
  /** Populated only when `failure_kind === 'signal'`. */
  failure_signal: string | null;
  /** Discriminator for `TaskCancellation`. NULL for legacy cancelled rows. */
  cancellation_kind: string | null;
  /** `TaskCancellation.message`. NULL for legacy cancelled rows. */
  cancellation_message: string | null;
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
  /**
   * Task IDs whose legacy v2 failure row we've already emitted a
   * "synthesised as kind='internal'" warn for. The warn would otherwise
   * fire on every read (e.g. dashboard list-refresh polls), flooding
   * operator logs. The Set is process-lifetime — on startup it is empty
   * so the first warn after a restart still fires once per affected
   * row, which is the operator signal we want without the volume.
   */
  private readonly warnedLegacyFailureRows = new Set<string>();

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
        `SELECT id, agent, runtime, status, brief, details, created_at, started_at, ended_at,
                result_output, failure_error, failure_kind, failure_exit_code, failure_signal,
                cancellation_kind, cancellation_message, metadata
         FROM tasks WHERE id = ?`,
      )
      .get(id) as TaskRow | undefined;
    if (row === undefined) return null;
    return parseRow(id, row, this.logger, this.warnedLegacyFailureRows);
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

    // Decompose typed payloads back into columnar storage.
    //
    // `failure_error` is REUSED as the storage column for
    // `TaskFailure.message` post-ADR-001 — this avoids adding a
    // sixth `failure_message` column for what is conceptually the
    // same field as the legacy `failure_error`. The discriminator
    // (`failure_kind`) plus the variant-specific extras
    // (`failure_exit_code`, `failure_signal`) live in the new columns.
    const failure = task.failure;
    const cancellation = task.cancellation;
    const failureKind = failure?.kind ?? null;
    const failureMessage = failure?.message ?? null;
    const failureExitCode = failure?.kind === "exited" ? failure.exitCode : null;
    const failureSignal = failure?.kind === "signal" ? failure.signal : null;
    const cancellationKind = cancellation?.kind ?? null;
    const cancellationMessage = cancellation?.message ?? null;

    this.db
      .prepare(
        `INSERT INTO tasks (id, agent, runtime, status, brief, details, created_at, started_at,
                            ended_at, result_output, failure_error, failure_kind, failure_exit_code,
                            failure_signal, cancellation_kind, cancellation_message, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent = excluded.agent,
           runtime = excluded.runtime,
           status = excluded.status,
           brief = excluded.brief,
           details = excluded.details,
           created_at = excluded.created_at,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           result_output = excluded.result_output,
           failure_error = excluded.failure_error,
           failure_kind = excluded.failure_kind,
           failure_exit_code = excluded.failure_exit_code,
           failure_signal = excluded.failure_signal,
           cancellation_kind = excluded.cancellation_kind,
           cancellation_message = excluded.cancellation_message,
           metadata = excluded.metadata`,
      )
      .run(
        task.id,
        task.agent,
        runtime,
        task.status,
        task.brief,
        task.details ?? null,
        task.createdAt,
        task.startedAt ?? null,
        task.endedAt ?? null,
        task.result?.output ?? null,
        failureMessage,
        failureKind,
        failureExitCode,
        failureSignal,
        cancellationKind,
        cancellationMessage,
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
    let sql = `SELECT id, agent, runtime, status, brief, details, created_at, started_at, ended_at,
                      result_output, failure_error, failure_kind, failure_exit_code, failure_signal,
                      cancellation_kind, cancellation_message, metadata FROM tasks`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    const rows = this.db.prepare(sql).all(...params) as unknown as TaskRow[];
    const out: Task[] = [];
    for (const row of rows) {
      try {
        out.push(parseRow(row.id, row, this.logger, this.warnedLegacyFailureRows));
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
    // `schema_meta` row for the `task` pkg at HEAD. A missing row
    // means the caller skipped `runPkgMigrations` (always a wiring
    // bug); a mismatched version means the on-disk DB was written
    // by a different build than what this code understands.
    //
    // Both branches surface as the framework's typed errors
    // (`SchemaMetaNotBootstrappedError` / `SchemaMetaMismatchError`)
    // so consumers can route uniformly across every per-pkg repo.
    let existing: { version: number } | undefined;
    try {
      existing = this.db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as
        | { version: number }
        | undefined;
    } catch {
      // `schema_meta` itself missing → coordinator never ran.
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
 * Decode a `tasks` row into a {@link Task} entity. Storage-shape
 * concerns are handled here:
 *   - the `metadata` column is JSON-encoded text, so this function
 *     must parse it *and* reject syntactically-invalid JSON or
 *     non-object roots before handing the value to the entity factory
 *     (which only knows about typed JS values, not the JSON wire
 *     format we chose for this column);
 *   - the `runtime` value is a promoted column extracted from the
 *     metadata bag at save time; we re-fold it back into the bag here
 *     so the entity sees the same shape callers passed in originally;
 *   - the `failure_*` and `cancellation_*` columns are reassembled
 *     into the typed {@link TaskFailure} / {@link TaskCancellation}
 *     discriminated unions ADR-001 introduced. Legacy rows written
 *     before the schema bump have `failure_error` populated but
 *     `failure_kind` NULL — those are synthesised to
 *     `{ kind: 'internal', message }` with a one-line warning so
 *     operators can spot the pattern.
 *
 * Everything else (id format, status enum, ISO timestamps,
 * metadata-is-an-object, brief non-empty, failure/cancellation shape +
 * status-pairing) is validated by {@link Task.fromStored}.
 */
function parseRow(
  id: string,
  row: TaskRow,
  logger: Logger,
  warnedLegacyFailureRows: Set<string>,
): Task {
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

  const failure = reassembleFailure(id, row, logger, warnedLegacyFailureRows);
  const cancellation = reassembleCancellation(id, row, logger);

  return Task.fromStored({
    id,
    agent: row.agent,
    brief: row.brief,
    ...(row.details !== null ? { details: row.details } : {}),
    status: row.status as TaskStatus,
    metadata,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(row.result_output !== null ? { result: { output: row.result_output } } : {}),
    ...(failure !== undefined ? { failure } : {}),
    ...(cancellation !== undefined ? { cancellation } : {}),
  });
}

/**
 * Rebuild a {@link TaskFailure} from the columnar storage shape.
 *
 *   - both columns NULL                  → returns undefined (non-failure row)
 *   - `failure_kind` populated           → reconstruct the matching variant
 *                                          (`exited` reads `failure_exit_code`,
 *                                          `signal` reads `failure_signal`,
 *                                          the rest carry just `kind` +
 *                                          `message`)
 *   - `failure_kind` NULL but
 *     `failure_error` populated          → legacy v2 row written before
 *                                          ADR-001; synthesise
 *                                          `{ kind: 'internal', message }`
 *                                          and emit a one-line warn so
 *                                          operators can spot the pattern.
 *                                          The warn is deduped per task id
 *                                          via `warnedLegacyFailureRows`
 *                                          so list-refresh polls don't
 *                                          flood the log.
 *
 * Throws {@link CorruptedTaskError} on a `failure_kind` value outside
 * the closed union (defends against future schema drift or
 * column-level tampering).
 */
function reassembleFailure(
  id: string,
  row: TaskRow,
  logger: Logger,
  warnedLegacyFailureRows: Set<string>,
): TaskFailure | undefined {
  if (row.failure_kind === null) {
    if (row.failure_error === null) return undefined;
    // Legacy row: ADR-001 documents synthesising
    // `{ kind: 'internal', message }`. Emit a warn so operators see
    // the pattern in their logs and can plan a re-save if needed —
    // but only once per task id per process. Without the dedup the
    // warn fires on every read, and dashboard list-refresh polls
    // would flood the operator log for the same row.
    if (!warnedLegacyFailureRows.has(id)) {
      warnedLegacyFailureRows.add(id);
      logger.warn(
        { taskId: id, failureError: row.failure_error },
        "tasks: legacy failure row synthesised as kind='internal'",
      );
    }
    return { kind: "internal", message: row.failure_error };
  }
  const message = row.failure_error ?? "";
  switch (row.failure_kind) {
    case "exited": {
      if (row.failure_exit_code === null) {
        throw new CorruptedTaskError(
          id,
          "failure_exit_code is required when failure_kind='exited'",
        );
      }
      return { kind: "exited", exitCode: row.failure_exit_code, message };
    }
    case "signal": {
      if (row.failure_signal === null) {
        throw new CorruptedTaskError(id, "failure_signal is required when failure_kind='signal'");
      }
      return { kind: "signal", signal: row.failure_signal as NodeJS.Signals, message };
    }
    case "shutdown":
    case "orphan":
    case "internal":
      return { kind: row.failure_kind, message };
    default:
      throw new CorruptedTaskError(
        id,
        `failure_kind ${JSON.stringify(row.failure_kind)} is outside the closed union`,
      );
  }
}

/**
 * Rebuild a {@link TaskCancellation} from columnar storage.
 *
 *   - both columns NULL → returns undefined (non-cancelled row)
 *   - `cancellation_kind` populated → reconstruct the matching variant
 *   - `cancellation_kind` NULL but `status === 'cancelled'` → no
 *     legacy producer existed before ADR-001 (the kernel never wrote a
 *     `cancelled` row), but defend by synthesising
 *     `{ kind: 'user', message: 'cancelled by user' }` so a hand-
 *     crafted legacy row or a future schema-drift case stays parseable.
 */
function reassembleCancellation(
  id: string,
  row: TaskRow,
  logger: Logger,
): TaskCancellation | undefined {
  if (row.cancellation_kind === null) {
    if (row.status !== "cancelled") return undefined;
    // Status is cancelled but no kind/message recorded. No legacy
    // producer existed before ADR-001 (TaskManager never wrote a
    // `cancelled` row pre-ADR), but we defend so that a hand-rolled
    // legacy row or a future schema drift case parses.
    logger.warn(
      { taskId: id },
      "tasks: legacy cancelled row missing cancellation_kind; synthesised as kind='user'",
    );
    return { kind: "user", message: "cancelled by user" };
  }
  const message = row.cancellation_message ?? "";
  switch (row.cancellation_kind) {
    case "user":
    case "orphan":
      return { kind: row.cancellation_kind, message };
    default:
      throw new CorruptedTaskError(
        id,
        `cancellation_kind ${JSON.stringify(row.cancellation_kind)} is outside the closed union`,
      );
  }
}

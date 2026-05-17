import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
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
    return parseRow(id, row, this.logger);
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
        out.push(parseRow(row.id, row, this.logger));
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
    // Bootstrap the schema_meta table so we can read the current
    // version unconditionally. The `tasks` table is created lazily
    // depending on which version path we land on (fresh install vs
    // upgrade) so we never have to retro-fit a v1 CREATE TABLE
    // before the migration has run.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        pkg     TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0)
      );
    `);
    const existing = this.db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as
      | { version: number }
      | undefined;

    if (existing === undefined) {
      // Fresh install (or never saw a tasks table): create the
      // current schema directly. `IF NOT EXISTS` covers the edge
      // case where another build path created the table without a
      // schema_meta row (we don't ship that path, but defending
      // against it keeps the call idempotent under retries).
      this.createCurrentSchema();
      this.db
        .prepare("INSERT INTO schema_meta (pkg, version) VALUES (?, ?)")
        .run("task", TASK_PKG_SCHEMA_VERSION);
      return;
    }

    if (existing.version === TASK_PKG_SCHEMA_VERSION) {
      // Already at HEAD: assert the table exists (defensive — a
      // partially-written install could have schema_meta but no
      // tasks table) and return.
      this.createCurrentSchema();
      return;
    }

    // Staged migration. Each migrator updates the on-disk schema
    // in-place; we walk the chain from the persisted version up to
    // HEAD without intermediate schema_meta writes (the version
    // bump only commits once the entire chain succeeds, so a
    // mid-chain crash leaves the DB at the previous known-good
    // version and the next bootstrap retries from that point).
    let effective = existing.version;
    if (effective === 1) {
      // pre-1.0 hard cut: migrate v1 (`instructions`) → v2
      // (`brief` + `details`) in a single transaction. `brief` is
      // back-filled from the first 200 chars of `instructions` to
      // honour the new wire contract; the original text is
      // preserved verbatim in `details` so no user data is lost.
      migrateV1ToV2(this.db);
      effective = 2;
    }
    if (effective === 2) {
      // ADR-001: additive columns for the typed TaskFailure /
      // TaskCancellation unions. All new columns are nullable so
      // existing rows need no rewrite — see {@link parseRow} for
      // the legacy `failure_error`-only fallback.
      migrateV2ToV3(this.db);
      effective = 3;
    }
    if (effective !== TASK_PKG_SCHEMA_VERSION) {
      throw new Error(
        `task pkg schema mismatch: db has v${existing.version}, server supports v${TASK_PKG_SCHEMA_VERSION}.`,
      );
    }
    this.db
      .prepare("UPDATE schema_meta SET version = ? WHERE pkg = ?")
      .run(TASK_PKG_SCHEMA_VERSION, "task");
  }

  private createCurrentSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id                    TEXT PRIMARY KEY,
        agent                 TEXT NOT NULL,
        runtime               TEXT,
        status                TEXT NOT NULL,
        brief                 TEXT NOT NULL,
        details               TEXT,
        created_at            TEXT NOT NULL,
        started_at            TEXT,
        ended_at              TEXT,
        result_output         TEXT,
        failure_error         TEXT,
        failure_kind          TEXT,
        failure_exit_code     INTEGER,
        failure_signal        TEXT,
        cancellation_kind     TEXT,
        cancellation_message  TEXT,
        metadata              TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS tasks_status_idx     ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_runtime_idx    ON tasks(runtime);
      CREATE INDEX IF NOT EXISTS tasks_agent_idx      ON tasks(agent);
      CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at);
    `);
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
function parseRow(id: string, row: TaskRow, logger: Logger): Task {
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

  const failure = reassembleFailure(id, row, logger);
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
 *
 * Throws {@link CorruptedTaskError} on a `failure_kind` value outside
 * the closed union (defends against future schema drift or
 * column-level tampering).
 */
function reassembleFailure(id: string, row: TaskRow, logger: Logger): TaskFailure | undefined {
  if (row.failure_kind === null) {
    if (row.failure_error === null) return undefined;
    // Legacy row: ADR-001 documents synthesising
    // `{ kind: 'internal', message }`. Emit a warn so operators see
    // the pattern in their logs and can plan a re-save if needed.
    logger.warn(
      { taskId: id, failureError: row.failure_error },
      "tasks: legacy failure row synthesised as kind='internal'",
    );
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

/**
 * Migrate `tasks` from v1 (single `instructions TEXT NOT NULL`
 * column) to v2 (`brief TEXT NOT NULL`, `details TEXT NULL`). SQLite
 * doesn't support `ALTER COLUMN`, so we use the canonical
 * "create new table → copy rows → drop old → rename" dance inside a
 * transaction.
 *
 * Back-fill rule: `brief` = first 200 chars of `instructions`,
 * `details` = full `instructions`. This is intentionally lossy on the
 * brief to honour the new wire contract (the route layer rejects
 * `brief.length > 200`); the full text is preserved verbatim in
 * `details` so no user content is lost.
 *
 * Empty-instructions edge case: a v1 row with `instructions = ""`
 * would translate to `brief = ""`, which v2 rejects via
 * `Task.fromStored`. We coerce empty briefs to a placeholder so the
 * row stays parseable; the operator can then re-run / archive at
 * leisure. Same defensive principle applied for very long values:
 * the substring is a hard slice, no semantic awareness.
 */
function migrateV1ToV2(db: DatabaseSync): void {
  // The transaction lets us rebuild the table atomically — a crash
  // mid-migration leaves the original `tasks` intact rather than a
  // half-renamed pair. Prepared statements would be overkill (the SQL
  // is one-shot) but exec() of a multi-statement payload is the
  // standard idiom.
  db.exec(`
    BEGIN;
    CREATE TABLE tasks_v2 (
      id              TEXT PRIMARY KEY,
      agent           TEXT NOT NULL,
      runtime         TEXT,
      status          TEXT NOT NULL,
      brief           TEXT NOT NULL,
      details         TEXT,
      created_at      TEXT NOT NULL,
      started_at      TEXT,
      ended_at        TEXT,
      result_output   TEXT,
      failure_error   TEXT,
      metadata        TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO tasks_v2 (
      id, agent, runtime, status, brief, details, created_at,
      started_at, ended_at, result_output, failure_error, metadata
    )
    SELECT
      id,
      agent,
      runtime,
      status,
      CASE
        WHEN length(instructions) = 0 THEN '(untitled)'
        ELSE substr(instructions, 1, 200)
      END AS brief,
      instructions AS details,
      created_at,
      started_at,
      ended_at,
      result_output,
      failure_error,
      metadata
    FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_v2 RENAME TO tasks;
    CREATE INDEX IF NOT EXISTS tasks_status_idx     ON tasks(status);
    CREATE INDEX IF NOT EXISTS tasks_runtime_idx    ON tasks(runtime);
    CREATE INDEX IF NOT EXISTS tasks_agent_idx      ON tasks(agent);
    CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at);
    COMMIT;
  `);
}

/**
 * Migrate `tasks` from v2 → v3 for ADR-001's structured
 * `TaskFailure` / `TaskCancellation` discriminated unions.
 *
 * Purely additive: five new nullable columns. No existing data needs
 * to move; the legacy `failure_error` column is REUSED as the storage
 * column for `TaskFailure.message` (see {@link parseRow}), and the
 * read path synthesises `{ kind: 'internal', message: failure_error }`
 * for rows whose `failure_kind` is NULL — which is every v2 row.
 *
 * We deliberately do NOT use the rename-dance from v1→v2 here: that
 * dance was required because the `instructions` column had to be split
 * into two NOT-NULL columns. v2→v3 only adds nullable columns, so
 * `ALTER TABLE ADD COLUMN` is sufficient and avoids the per-row
 * rewrite cost of CREATE+INSERT+DROP+RENAME on workspaces with many
 * tasks.
 */
function migrateV2ToV3(db: DatabaseSync): void {
  db.exec(`
    BEGIN;
    ALTER TABLE tasks ADD COLUMN failure_kind         TEXT;
    ALTER TABLE tasks ADD COLUMN failure_exit_code    INTEGER;
    ALTER TABLE tasks ADD COLUMN failure_signal       TEXT;
    ALTER TABLE tasks ADD COLUMN cancellation_kind    TEXT;
    ALTER TABLE tasks ADD COLUMN cancellation_message TEXT;
    COMMIT;
  `);
}

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { InvalidSessionIdError, SessionCorruptedError } from "../errors.js";
import { SESSION_ID_RE } from "../ids.js";
import type { ListSessionStateOpts, SessionRepository, SessionState } from "./repository.js";

/**
 * Current on-disk schema version for `sessions.db`.
 *
 * Bump when an existing column is removed, renamed, or its semantics
 * change in a way an older server cannot ignore. Purely additive
 * changes (new column with sensible default) do not require a bump.
 *
 * Mismatch behaviour mirrors `@emploke/workspace`'s policy: refuse to
 * open with a direction-aware message ("upgrade your server" vs "no
 * migration code").
 */
const CURRENT_SCHEMA_VERSION = 1;

interface SessionRow {
  id: string;
  runtime: string;
  created_at: string;
  runtime_session_id: string | null;
  last_launch_mode: string | null;
}

/**
 * SQLite-backed `SessionRepository`. Each session's metadata lives in
 * a row of the `sessions` table inside `<sessionsDir>/sessions.db`.
 * The session's workdir (`<sessionsDir>/<id>/`) — AGENTS.md and any
 * agent-produced files — is **not** owned by this repository; it stays
 * a plain directory tree on disk.
 *
 * Defense-in-depth: every public method validates `id` against
 * `SESSION_ID_RE` before composing SQL. Mirrors the path-traversal
 * defence the old `FsSessionRepository` did against ids being used to
 * build on-disk paths. Even though SQLite parameter binding makes id
 * injection harmless, keeping the validation makes the semantics of
 * "this is a sessions namespace, not arbitrary keys" explicit.
 *
 * Concurrency: WAL mode + SQLite's internal serialisation. Per-id
 * writes don't need cross-process locking on top.
 */
export class SqliteSessionRepository implements SessionRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  /**
   * Open or create a sessions database at `dbPath`.
   *
   * Pass `":memory:"` for tests — the in-memory DB lives only as long
   * as the connection. The parent directory of `dbPath` is created
   * recursively if it doesn't already exist (no-op for `:memory:`).
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

  /**
   * Close the underlying database connection. Tests that create
   * file-backed repositories should call this in cleanup so the WAL
   * sidecar files release on Windows. No-op safe to call repeatedly.
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed; idempotent.
    }
  }

  async read(id: string): Promise<SessionState | null> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    const row = this.db
      .prepare(
        "SELECT id, runtime, created_at, runtime_session_id, last_launch_mode FROM sessions WHERE id = ?",
      )
      .get(id) as SessionRow | undefined;
    if (row === undefined) return null;
    return rowToState(id, row);
  }

  async save(id: string, state: SessionState): Promise<void> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    this.db
      .prepare(
        `INSERT INTO sessions (id, runtime, created_at, runtime_session_id, last_launch_mode)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           runtime = excluded.runtime,
           created_at = excluded.created_at,
           runtime_session_id = excluded.runtime_session_id,
           last_launch_mode = excluded.last_launch_mode`,
      )
      .run(
        id,
        state.runtime,
        state.createdAt,
        state.runtimeSessionId,
        state.lastLaunchMode ?? null,
      );
  }

  async patchLastLaunchMode(id: string, mode: "local" | "remote"): Promise<void> {
    // Defensive id validation matches `read`/`save` — keeps the
    // namespace contract explicit even though parameter binding makes
    // injection harmless.
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    // Single-statement UPDATE: SQLite serialises this against any
    // concurrent `save`/`patchLastLaunchMode` on the same connection,
    // so two parallel callers (e.g. multi-tab "Resume Local" /
    // "Resume Remote") cannot lose each other's *other* fields the
    // way the old `read → save({...prev, lastLaunchMode})` path did.
    // Last writer of the column itself still wins — that's the
    // intended UX for "what mode did I last pick?".
    //
    // Missing-row case is a silent no-op: the manager has no
    // session-row to update yet (e.g. it was just deleted between
    // `loadSession` and here), and there's nothing useful to do.
    this.db.prepare("UPDATE sessions SET last_launch_mode = ? WHERE id = ?").run(mode, id);
  }

  async delete(id: string): Promise<void> {
    // Idempotent: invalid ids cannot match anything in the table anyway.
    // Returning silently mirrors `SqliteTaskRepository.delete`.
    if (!SESSION_ID_RE.test(id)) return;
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async list(opts: ListSessionStateOpts = {}): Promise<{ id: string; state: SessionState }[]> {
    let sql = "SELECT id, runtime, created_at, runtime_session_id, last_launch_mode FROM sessions";
    const params: string[] = [];
    if (opts.createdSince !== undefined) {
      sql += " WHERE created_at >= ?";
      params.push(opts.createdSince);
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as SessionRow[];
    const out: { id: string; state: SessionState }[] = [];
    for (const row of rows) {
      try {
        out.push({ id: row.id, state: rowToState(row.id, row) });
      } catch (err) {
        // Corrupted row — drop from list. Matches the old
        // FsSessionRepository.list behaviour (silently skip a single
        // corrupted entry rather than fail the whole call). We warn
        // via the injected logger so operators can see the bad row
        // without `list` itself failing.
        this.logger.warn("sessions: skipping corrupted session row", {
          sessionId: row.id ?? null,
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
        "sessions.db: schema_meta table exists but is empty (db is corrupted; remove it and restart)",
      );
    }
    if (row.version === CURRENT_SCHEMA_VERSION) return;
    if (row.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `sessions.db was written by a newer emploke (schema v${row.version}; this server supports v${CURRENT_SCHEMA_VERSION}). Upgrade the server to read it.`,
      );
    }
    throw new Error(
      `sessions.db was written by an older emploke (schema v${row.version}; this server supports v${CURRENT_SCHEMA_VERSION}). Migration from older versions is not yet implemented.`,
    );
  }

  private createSchema(): void {
    // Bootstrap inside a transaction so a crash mid-DDL leaves an empty
    // db (caller treats that as "fresh, recreate") rather than a
    // half-built one (schema_meta present but `sessions` missing → reads
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
        CREATE TABLE IF NOT EXISTS sessions (
          id                  TEXT PRIMARY KEY,
          runtime             TEXT NOT NULL,
          created_at          TEXT NOT NULL,
          runtime_session_id  TEXT,
          last_launch_mode    TEXT
        );
        CREATE INDEX IF NOT EXISTS sessions_runtime_idx    ON sessions(runtime);
        CREATE INDEX IF NOT EXISTS sessions_created_at_idx ON sessions(created_at);
      `);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function rowToState(id: string, row: SessionRow): SessionState {
  if (typeof row.runtime !== "string" || row.runtime.length === 0) {
    throw new SessionCorruptedError(id, "missing or invalid 'runtime'");
  }
  if (typeof row.created_at !== "string" || row.created_at.length === 0) {
    throw new SessionCorruptedError(id, "missing or invalid 'created_at'");
  }
  if (row.runtime_session_id !== null && typeof row.runtime_session_id !== "string") {
    throw new SessionCorruptedError(id, "'runtime_session_id' must be string or null");
  }
  if (
    row.last_launch_mode !== null &&
    row.last_launch_mode !== "local" &&
    row.last_launch_mode !== "remote"
  ) {
    throw new SessionCorruptedError(id, "'last_launch_mode' must be 'local', 'remote', or null");
  }
  const out: SessionState = {
    runtime: row.runtime,
    createdAt: row.created_at,
    runtimeSessionId: row.runtime_session_id,
  };
  if (row.last_launch_mode !== null) {
    return { ...out, lastLaunchMode: row.last_launch_mode };
  }
  return out;
}

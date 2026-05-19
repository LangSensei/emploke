import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import { SchemaMetaMismatchError, SchemaMetaNotBootstrappedError } from "@emploke/workspace";
import { InvalidSessionIdError } from "../errors.js";
import { SESSION_ID_RE } from "../ids.js";
import { Session } from "../session-entity.js";
import type { ListSessionStateOpts, SessionRepository } from "./repository.js";

/**
 * Current schema version for the session pkg's slice of the shared
 * per-workspace `workspace.db`. Stored in `schema_meta(pkg='session')`.
 *
 * Bump when an existing column is removed, renamed, or its semantics
 * change in a way an older server cannot ignore. Purely additive
 * changes (new column with sensible default) do not require a bump.
 */
const SESSION_PKG_SCHEMA_VERSION = 1;

interface SessionRow {
  id: string;
  runtime: string;
  created_at: string;
  runtime_session_id: string | null;
  last_launch_mode: string | null;
}

/**
 * SQLite-backed `SessionRepository`. Each session's metadata lives in
 * a row of the `sessions` table inside the **shared per-workspace
 * database** (`<workspace>/workspace.db`). The session's workdir
 * (`<sessionsDir>/<id>/`) — AGENTS.md and any agent-produced files —
 * is **not** owned by this repository; it stays a plain directory tree
 * on disk.
 *
 * Defense-in-depth: every public method validates `id` against
 * `SESSION_ID_RE` before composing SQL. Mirrors the path-traversal
 * defence the old `FsSessionRepository` did against ids being used to
 * build on-disk paths. Even though SQLite parameter binding makes id
 * injection harmless, keeping the validation makes the semantics of
 * "this is a sessions namespace, not arbitrary keys" explicit.
 *
 * The constructor takes an already-opened `DatabaseSync`. The server
 * shares one connection across every per-workspace repository
 * (task / session / catalog / workflow), so cross-entity JOINs and
 * atomic multi-table transactions are cheap and the file handle count
 * per workspace stays at one. PRAGMAs (journal_mode, synchronous, ...)
 * are the caller's responsibility — the workspace pkg sets them once
 * on the shared connection.
 *
 * Row-to-entity decoding is delegated to
 * {@link Session.fromStored}: the repository is the source of
 * bytes, the entity is the source of validation. Local helper
 * `parseRow` only handles concerns SQLite exposes (nullable
 * `last_launch_mode` column ↔ optional entity field) before handing
 * the rest to the entity factory.
 */
export class SqliteSessionRepository implements SessionRepository {
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

  async read(id: string): Promise<Session | null> {
    if (!SESSION_ID_RE.test(id)) throw new InvalidSessionIdError(id);
    const row = this.db
      .prepare(
        "SELECT id, runtime, created_at, runtime_session_id, last_launch_mode FROM sessions WHERE id = ?",
      )
      .get(id) as SessionRow | undefined;
    if (row === undefined) return null;
    return parseRow(id, row);
  }

  async save(id: string, state: Session): Promise<void> {
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

  async list(opts: ListSessionStateOpts = {}): Promise<{ id: string; state: Session }[]> {
    let sql = "SELECT id, runtime, created_at, runtime_session_id, last_launch_mode FROM sessions";
    const params: string[] = [];
    if (opts.createdSince !== undefined) {
      sql += " WHERE created_at >= ?";
      params.push(opts.createdSince);
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as SessionRow[];
    const out: { id: string; state: Session }[] = [];
    for (const row of rows) {
      try {
        out.push({ id: row.id, state: parseRow(row.id, row) });
      } catch (err) {
        // Corrupted row — drop from list. Matches the old
        // FsSessionRepository.list behaviour (silently skip a single
        // corrupted entry rather than fail the whole call). We warn
        // via the injected logger so operators can see the bad row
        // without `list` itself failing.
        this.logger.warn(
          {
            sessionId: row.id ?? null,
            reason: err instanceof Error ? err.message : String(err),
          },
          "sessions: skipping corrupted session row",
        );
      }
    }
    return out;
  }

  // ─── schema management ──────────────────────────────────────

  private ensureSchema(): void {
    // Post-issue-#123: the MigrationCoordinator owns DDL. This
    // repository's job is to assert the post-condition — a
    // `schema_meta` row for the `session` pkg at the expected
    // version. A missing row means the caller forgot to run
    // `runPkgMigrations` (always a wiring bug); a mismatched
    // version means the on-disk DB was written by a different
    // build than what this code understands.
    //
    // Both branches surface as typed errors from
    // `@emploke/workspace/migration` so consumers can route a single
    // `instanceof SchemaMetaNotBootstrappedError` /
    // `instanceof SchemaMetaMismatchError` handler uniformly across
    // every per-pkg repository (session, task, catalog_*).
    let existing: { version: number } | undefined;
    try {
      existing = this.db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("session") as
        | { version: number }
        | undefined;
    } catch {
      // `schema_meta` itself missing → coordinator never ran.
      throw new SchemaMetaNotBootstrappedError("session");
    }
    if (existing === undefined) {
      throw new SchemaMetaNotBootstrappedError("session");
    }
    if (existing.version !== SESSION_PKG_SCHEMA_VERSION) {
      throw new SchemaMetaMismatchError("session", existing.version, SESSION_PKG_SCHEMA_VERSION);
    }
  }
}

/**
 * Decode a `sessions` row into a {@link Session} entity. The
 * nullable `last_launch_mode` column is mapped to the optional entity
 * field; everything else (id presence, runtime non-empty, ISO
 * timestamps, mode enum values) is validated by
 * {@link Session.fromStored}.
 */
function parseRow(id: string, row: SessionRow): Session {
  return Session.fromStored({
    id,
    runtime: row.runtime,
    createdAt: row.created_at,
    runtimeSessionId: row.runtime_session_id,
    ...(row.last_launch_mode !== null
      ? { lastLaunchMode: row.last_launch_mode as "local" | "remote" }
      : {}),
  });
}

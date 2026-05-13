import { rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { mkdirP, readJson, writeJsonAtomic } from "@emploke/fs";
import { type Logger, silentLogger } from "@emploke/logger";
import { WORKSPACE_FILE } from "../constants.js";
import {
  RegistrySchemaMismatchError,
  WorkspaceCorruptedError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../errors.js";
import { parseWorkspaceMetadata, serializeWorkspaceMetadata } from "../metadata-codec.js";
import { isValidWorkspaceId } from "../names.js";
import type { Workspace } from "../types.js";
import type { WorkspaceRepository } from "./repository.js";

/**
 * Schema version for the workspace pkg's tables inside `global.db`.
 *
 * Stored in `schema_meta(pkg = 'workspace')`. Bump when an existing
 * column is removed, renamed, or its semantics change in a way an older
 * server cannot ignore. Mismatch behaviour mirrors the JSON repository:
 * refuse to open with a direction-aware message.
 */
const WORKSPACE_PKG_SCHEMA_VERSION = 1;

/** Key in `global_state` holding the current-workspace pointer. */
const CURRENT_WORKSPACE_KEY = "current_workspace_id";

interface RegistryRow {
  id: string;
  workdir: string;
  registered_at: string;
  last_opened_at: string | null;
}

/**
 * SQLite-backed `WorkspaceRepository`. The workspace **registry** —
 * which workspaces exist, where on disk they live, which one is
 * "current" — lives in `<EMPLOKE_HOME>/global.db`. Per-workspace
 * **metadata** (name, createdAt, defaults) currently still lives in
 * `<workdir>/workspace.json` and is hydrated on `read` / `list`.
 *
 * ## Why a global SQLite registry, not `workspaces.json`?
 *
 * - **Atomic concurrency**: SQLite's write lock + UNIQUE constraints
 *   replace the advisory `withFileLock` dance the FS repo needs to do
 *   on every read-modify-write. Two concurrent `emploke workspace add`
 *   calls cannot lose each other's entries.
 * - **One file fewer**: `<EMPLOKE_HOME>` keeps just `global.db` +
 *   `runtime.json` + `logs/` instead of also a hand-mergeable JSON.
 * - **Forward compatibility**: future "cross-workspace" features
 *   (audit logs, global indexes) get a natural home without inventing
 *   a second JSON file.
 *
 * ## Hybrid metadata storage (for now)
 *
 * Until the per-workspace `workspace.db` lands (a follow-up PR), this
 * repository still reads/writes `<workdir>/workspace.json` for the
 * fields that travel with the workspace folder (name, createdAt,
 * defaults). Once the workspace-level DB exists those fields move to
 * its `workspace_meta` table; this class will then read them from
 * there instead. The `WorkspaceRepository` interface is unchanged
 * across both stages.
 *
 * ## Connection ownership
 *
 * The constructor takes an already-opened `DatabaseSync` rather than
 * a path. Callers (the server bootstrap, tests) own the connection's
 * lifetime — important because future sibling code in the same DB
 * (other pkgs writing to `global.db`) needs to share one handle.
 *
 * ## Schema initialisation
 *
 * On open, this repository ensures its three tables exist
 * (`schema_meta`, `workspace_registry`, `global_state`). If the rows
 * already exist with a mismatching `pkg='workspace'` version, opening
 * throws `RegistrySchemaMismatchError` — a downgrade-or-migration
 * hint the operator can act on.
 */
export class SqliteWorkspaceRepository implements WorkspaceRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  /**
   * Build a repository on top of an opened `global.db` connection.
   *
   * The caller owns `db.close()`. Callers wanting an isolated test
   * instance can pass a `new DatabaseSync(":memory:")`.
   */
  constructor(opts: { db: DatabaseSync; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    // SQLite pragmas. We deliberately use the default rollback journal
    // (DELETE) rather than WAL: the workspace registry has a very low
    // write rate (registry changes are rare events triggered by user
    // CLI calls) so WAL's concurrent-reader benefit is unused, while
    // its `-wal` / `-shm` sidecar files create flaky cleanup on
    // Windows when integration tests rm-rf the EMPLOKE_HOME mid-test.
    // Other entity packages (task / session / catalog) need WAL for
    // their high-write paths; this one does not.
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.ensureSchema();
  }

  async list(): Promise<Workspace[]> {
    const rows = this.db
      .prepare(
        "SELECT id, workdir, registered_at, last_opened_at FROM workspace_registry ORDER BY registered_at",
      )
      .all() as unknown as RegistryRow[];
    const out: Workspace[] = [];
    for (const row of rows) {
      let ws: Workspace | null = null;
      try {
        ws = await this.tryHydrate(row);
      } catch (err) {
        // Mirrors FsWorkspaceRepository.list: a corrupted single
        // workspace.json shouldn't take down the whole list. We log so
        // operators can find the bad entry; single-id `read` callers
        // still get the typed error.
        this.logger.warn("workspace registry: skipping corrupted workspace", {
          workspaceId: row.id,
          workdir: row.workdir,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      if (ws) out.push(ws);
    }
    return out;
  }

  async read(id: string): Promise<Workspace | null> {
    if (!isValidWorkspaceId(id)) {
      // Treat invalid id as "not found" rather than throwing — it
      // matches the FS repository's behaviour for unknown ids and
      // keeps `read` a pure lookup (404, not 400).
      return null;
    }
    const row = this.db
      .prepare(
        "SELECT id, workdir, registered_at, last_opened_at FROM workspace_registry WHERE id = ?",
      )
      .get(id) as RegistryRow | undefined;
    if (row === undefined) return null;
    return this.tryHydrate(row);
  }

  async save(workspace: Workspace): Promise<void> {
    if (!isValidWorkspaceId(workspace.id)) {
      throw new WorkspaceIdInvalidError(workspace.id);
    }
    const resolvedWorkdir = path.resolve(workspace.workdir);
    const metadataFile = path.join(resolvedWorkdir, WORKSPACE_FILE);
    const persistedMetadata = serializeWorkspaceMetadata(workspace);

    // The metadata file lives in the workspace's own workdir; write it
    // FIRST so a crash between metadata write and registry write leaves
    // "metadata exists but unregistered" rather than "registry pointing
    // at no metadata". This mirrors the FS implementation's invariant.
    await writeJsonAtomic(metadataFile, persistedMetadata);

    // Path-conflict check + upsert in one transaction so two concurrent
    // `save`s with different ids targeting the same workdir cannot both
    // succeed (the second would see the first's row and throw).
    this.runInTransaction(() => {
      const conflict = this.db
        .prepare("SELECT id FROM workspace_registry WHERE workdir = ? AND id != ?")
        .get(resolvedWorkdir, workspace.id) as { id: string } | undefined;
      if (conflict) {
        throw new WorkspacePathConflictError(resolvedWorkdir, conflict.id);
      }
      // Preserve last_opened_at on update (it's a UX hint independent
      // of the workspace's own metadata).
      this.db
        .prepare(
          `INSERT INTO workspace_registry (id, workdir, registered_at, last_opened_at)
           VALUES (?, ?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET
             workdir = excluded.workdir`,
        )
        .run(workspace.id, resolvedWorkdir, new Date().toISOString());
    });
  }

  async create(workspace: Workspace): Promise<void> {
    if (!isValidWorkspaceId(workspace.id)) {
      throw new WorkspaceIdInvalidError(workspace.id);
    }
    const resolvedWorkdir = path.resolve(workspace.workdir);
    const metadataFile = path.join(resolvedWorkdir, WORKSPACE_FILE);
    const persistedMetadata = serializeWorkspaceMetadata(workspace);

    // Ensure the workdir exists before writing the metadata file. Fresh
    // installs hit this when init creates a new directory.
    await mkdirP(resolvedWorkdir);
    await writeJsonAtomic(metadataFile, persistedMetadata);

    // Atomic create-or-fail. Both id-conflict and path-conflict checks
    // run inside the transaction so two concurrent `create` calls with
    // the same id (or same workdir) cannot both succeed.
    this.runInTransaction(() => {
      const idConflict = this.db
        .prepare("SELECT 1 FROM workspace_registry WHERE id = ?")
        .get(workspace.id);
      if (idConflict !== undefined) {
        throw new WorkspaceIdConflictError(workspace.id);
      }
      const pathConflict = this.db
        .prepare("SELECT id FROM workspace_registry WHERE workdir = ?")
        .get(resolvedWorkdir) as { id: string } | undefined;
      if (pathConflict) {
        throw new WorkspacePathConflictError(resolvedWorkdir, pathConflict.id);
      }
      this.db
        .prepare(
          "INSERT INTO workspace_registry (id, workdir, registered_at, last_opened_at) VALUES (?, ?, ?, NULL)",
        )
        .run(workspace.id, resolvedWorkdir, new Date().toISOString());
    });
  }

  async delete(id: string): Promise<void> {
    if (!isValidWorkspaceId(id)) {
      // Idempotent on bad ids — matches FsWorkspaceRepository.delete.
      return;
    }
    let removedWorkdir: string | null = null;
    this.runInTransaction(() => {
      const row = this.db.prepare("SELECT workdir FROM workspace_registry WHERE id = ?").get(id) as
        | { workdir: string }
        | undefined;
      if (!row) return;
      removedWorkdir = row.workdir;
      this.db.prepare("DELETE FROM workspace_registry WHERE id = ?").run(id);
      // Clear the current-workspace pointer if it referenced this id.
      // This matches FsWorkspaceRepository's "if currentId == id, drop
      // it" semantics.
      this.db
        .prepare("DELETE FROM global_state WHERE key = ? AND value = ?")
        .run(CURRENT_WORKSPACE_KEY, id);
    });
    if (removedWorkdir !== null) {
      const metadataFile = path.join(removedWorkdir, WORKSPACE_FILE);
      await rm(metadataFile, { force: true });
    }
  }

  async getCurrent(): Promise<string | null> {
    const row = this.db
      .prepare("SELECT value FROM global_state WHERE key = ?")
      .get(CURRENT_WORKSPACE_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setCurrent(id: string): Promise<void> {
    if (!isValidWorkspaceId(id)) {
      throw new WorkspaceNotRegisteredError(id);
    }
    this.runInTransaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM workspace_registry WHERE id = ?").get(id);
      if (exists === undefined) {
        throw new WorkspaceNotRegisteredError(id);
      }
      // Bump last_opened_at to record recency — same UX hint the FS
      // repository tracked on every setCurrent.
      this.db
        .prepare("UPDATE workspace_registry SET last_opened_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      this.db
        .prepare(
          `INSERT INTO global_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(CURRENT_WORKSPACE_KEY, id);
    });
  }

  // ── internals ───────────────────────────────────────────────

  private async tryHydrate(row: RegistryRow): Promise<Workspace | null> {
    const metadataFile = path.join(row.workdir, WORKSPACE_FILE);
    let raw: unknown;
    try {
      raw = await readJson(metadataFile);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        row.workdir,
        `unreadable workspace.json: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (raw === null) {
      // Mirrors FsWorkspaceRepository.tryHydrate: missing metadata file
      // => drop from list silently, let the registry heal on next
      // delete/re-register.
      return null;
    }
    return parseWorkspaceMetadata(row.id, row.workdir, raw);
  }

  private runInTransaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── schema management ──────────────────────────────────────

  private ensureSchema(): void {
    // Bootstrap inside a transaction so a crash mid-DDL leaves an empty
    // db (caller treats that as "fresh, recreate") rather than a
    // half-built one. `IF NOT EXISTS` + `INSERT OR IGNORE` makes the
    // bootstrap race-safe across concurrent first-opens of the same
    // dbPath (rare in practice — one server per home — but free
    // defence).
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          pkg     TEXT PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0)
        );
        CREATE TABLE IF NOT EXISTS workspace_registry (
          id              TEXT PRIMARY KEY NOT NULL,
          workdir         TEXT NOT NULL UNIQUE,
          registered_at   TEXT NOT NULL,
          last_opened_at  TEXT
        );
        CREATE TABLE IF NOT EXISTS global_state (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    // Schema-version handshake: ensure the row exists at the current
    // version. If a previous emploke wrote a different version, fail
    // with a typed mismatch error so the operator sees a clear hint.
    const existing = this.db
      .prepare("SELECT version FROM schema_meta WHERE pkg = ?")
      .get("workspace") as { version: number } | undefined;
    if (existing === undefined) {
      this.db
        .prepare("INSERT INTO schema_meta (pkg, version) VALUES (?, ?)")
        .run("workspace", WORKSPACE_PKG_SCHEMA_VERSION);
      return;
    }
    if (existing.version === WORKSPACE_PKG_SCHEMA_VERSION) return;
    if (existing.version > WORKSPACE_PKG_SCHEMA_VERSION) {
      throw new RegistrySchemaMismatchError(
        "global.db (workspace pkg)",
        existing.version,
        WORKSPACE_PKG_SCHEMA_VERSION,
      );
    }
    throw new RegistrySchemaMismatchError(
      "global.db (workspace pkg)",
      existing.version,
      WORKSPACE_PKG_SCHEMA_VERSION,
    );
  }
}

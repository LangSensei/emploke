import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import {
  RegistryNotBootstrappedError,
  RegistrySchemaMismatchError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../errors.js";
import { isValidWorkspaceId } from "../names.js";
import { Workspace } from "../workspace-entity.js";
import type { WorkspaceRepository } from "./repository.js";

const WORKSPACE_PKG_SCHEMA_VERSION = 2;

/** Key in `global_state` holding the current-workspace pointer. */
const CURRENT_WORKSPACE_KEY = "current_workspace_id";

interface WorkspaceRow {
  id: string;
  workspace_dir: string;
  name: string;
  created_at: string;
  registered_at: string;
  last_opened_at: string | null;
}

/**
 * SQLite-backed `WorkspaceRepository`. Every workspace's complete
 * record — id, `workspace_dir`, name, createdAt, plus registry-only
 * timing fields — lives in a single `workspaces` row inside
 * `<EMPLOKE_HOME>/global.db`. There is no per-workspace metadata file
 * (no `workspace.json`); a workspace folder contains only emploke's
 * per-workspace `workspace.db` plus agent-owned files.
 *
 * The earlier design split "registry" (`global.db`) from "metadata"
 * (`<workspaceDir>/workspace.json`) under the assumption that a
 * workspace folder should be self-describing if copied to another
 * machine. In practice emploke is a server-centric tool — workspace
 * folders are agent workdirs, not portable bundles — and the split
 * cost `list()` an N+1 file-read fan-out for every dashboard refresh.
 * Consolidating into a single SQLite row makes `list()` one indexed
 * scan and removes the JSON sidecar entirely.
 */
export class SqliteWorkspaceRepository implements WorkspaceRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;
  private closed = false;

  constructor(opts: { db: DatabaseSync; logger?: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger ?? silentLogger;
    // SQLite pragmas. We deliberately use the default rollback journal
    // (DELETE) rather than WAL: the workspace registry has a very low
    // write rate, so WAL's concurrent-reader benefit is unused while
    // its sidecar files create flaky cleanup on Windows when CLI
    // integration tests rm-rf the EMPLOKE_HOME mid-test. Per-workspace
    // databases (`workspace.db`) need WAL for high-write paths; this
    // one does not.
    //
    // `busy_timeout = 5000` makes any second writer (today only a
    // future migration tool — server is the sole production writer)
    // wait up to 5s on the file lock instead of immediately surfacing
    // SQLITE_BUSY. With journal_mode=DELETE and the default
    // busy_timeout=0, contention is "fail fast" which is the wrong
    // tradeoff for short bursty writes on a low-traffic registry.
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.ensureSchema();
  }

  async list(): Promise<Workspace[]> {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_dir, name, created_at, registered_at, last_opened_at
         FROM workspaces ORDER BY registered_at`,
      )
      .all() as unknown as WorkspaceRow[];
    const out: Workspace[] = [];
    for (const row of rows) {
      try {
        out.push(rowToWorkspace(row));
      } catch (err) {
        this.logger.warn(
          {
            workspaceId: row.id,
            workspaceDir: row.workspace_dir,
            reason: err instanceof Error ? err.message : String(err),
          },
          "workspaces: skipping corrupted row",
        );
      }
    }
    return out;
  }

  async read(id: string): Promise<Workspace | null> {
    if (!isValidWorkspaceId(id)) return null;
    const row = this.db
      .prepare(
        `SELECT id, workspace_dir, name, created_at, registered_at, last_opened_at
         FROM workspaces WHERE id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    if (row === undefined) return null;
    return rowToWorkspace(row);
  }

  async save(workspace: Workspace): Promise<void> {
    if (!isValidWorkspaceId(workspace.id)) {
      throw new WorkspaceIdInvalidError(workspace.id);
    }
    const resolvedWorkspaceDir = path.resolve(workspace.workspaceDir);

    this.runInTransaction(() => {
      // Path-conflict check stays for defence in depth — although
      // `WorkspaceManager.update` only flows through `withMetadata`
      // (which preserves workspaceDir), the public repository
      // contract accepts an arbitrary `Workspace`, so a buggy caller
      // could still pass a colliding workspaceDir.
      const conflict = this.db
        .prepare("SELECT id FROM workspaces WHERE workspace_dir = ? AND id != ?")
        .get(resolvedWorkspaceDir, workspace.id) as { id: string } | undefined;
      if (conflict) {
        throw new WorkspacePathConflictError(resolvedWorkspaceDir, conflict.id);
      }
      // Strict UPDATE — no upsert. If a concurrent `delete(id)` landed
      // between the manager's read() and save() calls, the row no
      // longer exists; surface that as a typed 404 instead of silently
      // resurrecting the workspace with the in-flight rename's name and
      // reset registry-side timing fields. `created_at` /
      // `registered_at` / `last_opened_at` are owned by `create` /
      // `setCurrent` and never touched here.
      const result = this.db
        .prepare(
          `UPDATE workspaces
              SET workspace_dir = ?, name = ?
              WHERE id = ?`,
        )
        .run(resolvedWorkspaceDir, workspace.name, workspace.id);
      if (result.changes === 0) {
        throw new WorkspaceNotRegisteredError(workspace.id);
      }
    });
  }

  async create(workspace: Workspace): Promise<void> {
    if (!isValidWorkspaceId(workspace.id)) {
      throw new WorkspaceIdInvalidError(workspace.id);
    }
    const resolvedWorkspaceDir = path.resolve(workspace.workspaceDir);

    this.runInTransaction(() => {
      const idConflict = this.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(workspace.id);
      if (idConflict !== undefined) {
        throw new WorkspaceIdConflictError(workspace.id);
      }
      const pathConflict = this.db
        .prepare("SELECT id FROM workspaces WHERE workspace_dir = ?")
        .get(resolvedWorkspaceDir) as { id: string } | undefined;
      if (pathConflict) {
        throw new WorkspacePathConflictError(resolvedWorkspaceDir, pathConflict.id);
      }
      this.db
        .prepare(
          `INSERT INTO workspaces (id, workspace_dir, name, created_at, registered_at, last_opened_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          workspace.id,
          resolvedWorkspaceDir,
          workspace.name,
          workspace.createdAt,
          new Date().toISOString(),
        );
    });
  }

  async delete(id: string): Promise<void> {
    if (!isValidWorkspaceId(id)) return;
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      this.db
        .prepare("DELETE FROM global_state WHERE key = ? AND value = ?")
        .run(CURRENT_WORKSPACE_KEY, id);
    });
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
      const exists = this.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(id);
      if (exists === undefined) {
        throw new WorkspaceNotRegisteredError(id);
      }
      this.db
        .prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      this.db
        .prepare(
          `INSERT INTO global_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(CURRENT_WORKSPACE_KEY, id);
    });
  }

  /**
   * Release the underlying SQLite handle. Idempotent. After `close()`
   * every other method throws (the `DatabaseSync` itself rejects
   * statement preparation on a closed handle).
   *
   * Windows blocks `unlink` on files with open handles, so the
   * server's graceful-shutdown path needs an explicit close before
   * any tear-down (`rm -rf <EMPLOKE_HOME>`) can succeed. POSIX is
   * lenient but we close here regardless — leaking a handle past
   * shutdown is a bug everywhere, just an invisible one outside
   * Windows.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // best-effort: a doubly-closed DatabaseSync throws; we already
      // flagged `closed` so subsequent close() calls short-circuit.
    }
  }

  // ── internals ───────────────────────────────────────────────

  private runInTransaction(fn: () => void): void {
    // `BEGIN IMMEDIATE` acquires the RESERVED write lock up front
    // instead of waiting for the first write inside the transaction.
    // Two concurrent transactions both claim the lock here (the second
    // waits up to `busy_timeout`), so neither can read stale data and
    // then race to write a conflicting commit.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private ensureSchema(): void {
    // Coordinator owns DDL post-issue-#123. The repository's job is
    // to assert the bootstrap post-condition: the DB has a
    // `schema_meta` row for the `workspace` pkg at the version this
    // build expects. A missing row means the caller skipped
    // `runPkgMigrations` — always a wiring bug. A mismatched version
    // means the on-disk DB was written by a different build (older
    // or newer) than what this code understands; the operator must
    // upgrade or downgrade.
    let existing: { version: number } | undefined;
    try {
      existing = this.db
        .prepare("SELECT version FROM schema_meta WHERE pkg = ?")
        .get("workspace") as { version: number } | undefined;
    } catch {
      // `schema_meta` itself missing → coordinator never ran.
      throw new RegistryNotBootstrappedError("global.db (workspace pkg)");
    }
    if (existing === undefined) {
      throw new RegistryNotBootstrappedError("global.db (workspace pkg)");
    }
    if (existing.version !== WORKSPACE_PKG_SCHEMA_VERSION) {
      throw new RegistrySchemaMismatchError(
        "global.db (workspace pkg)",
        existing.version,
        WORKSPACE_PKG_SCHEMA_VERSION,
      );
    }
  }
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return Workspace.fromStored({
    dir: row.workspace_dir,
    id: row.id,
    workspaceDir: row.workspace_dir,
    name: row.name,
    createdAt: row.created_at,
  });
}

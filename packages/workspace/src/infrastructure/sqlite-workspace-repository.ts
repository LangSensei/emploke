import { silentLogger } from "@emploke/logger";
import { inject, injectable } from "inversify";
import {
  RegistryNotBootstrappedError,
  RegistrySchemaMismatchError,
  WorkspaceIdConflictError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../domain/errors.js";
import type { WorkspaceId } from "../domain/value-objects/workspace-id.js";
import type { Workspace } from "../domain/workspace.js";
import { WorkspaceRepository } from "../domain/workspace-repository.js";
import { rowToWorkspace, type WorkspaceRow } from "./internal/row-mappers.js";
import { WorkspaceDb } from "./workspace-db.js";

const WORKSPACE_PKG_SCHEMA_VERSION = 2;

/** Key in `global_state` holding the current-workspace pointer. */
const CURRENT_WORKSPACE_KEY = "current_workspace_id";

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
 *
 * **Phase 1 NOTE on logging**: the previous incarnation took an
 * optional `logger` parameter and warned on corrupted-row skips. The
 * DI-style constructor drops that parameter for now (cf. #137 §6's
 * example takes only the DB). The corruption is still surfaced —
 * `findById(corruptId)` throws `WorkspaceCorruptedError` and `list()`
 * silently skips. When a `Logger` binding lands as part of the
 * cross-pkg observability slice, re-inject + restore the warn.
 */
@injectable()
export class SqliteWorkspaceRepository extends WorkspaceRepository {
  private closed = false;

  constructor(@inject(WorkspaceDb) private readonly db: WorkspaceDb) {
    super();
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
    this.assertSchema();
  }

  override async list(): Promise<Workspace[]> {
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
        silentLogger.warn(
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

  override async findById(id: WorkspaceId): Promise<Workspace | null> {
    const row = this.db
      .prepare(
        `SELECT id, workspace_dir, name, created_at, registered_at, last_opened_at
         FROM workspaces WHERE id = ?`,
      )
      .get(id.value) as WorkspaceRow | undefined;
    if (row === undefined) return null;
    return rowToWorkspace(row);
  }

  override async save(workspace: Workspace): Promise<void> {
    const resolvedDir = workspace.workspaceDir.value;

    this.runInTransaction(() => {
      // Path-conflict check stays for defence in depth — although the
      // current `RenameWorkspaceCommandHandler` only mutates name (so
      // workspaceDir is preserved), the public repository contract
      // accepts an arbitrary `Workspace`, so a buggy caller could
      // still pass a colliding workspaceDir.
      const conflict = this.db
        .prepare("SELECT id FROM workspaces WHERE workspace_dir = ? AND id != ?")
        .get(resolvedDir, workspace.id.value) as { id: string } | undefined;
      if (conflict) {
        throw new WorkspacePathConflictError(resolvedDir, conflict.id);
      }
      // Strict UPDATE — no upsert. If a concurrent `delete(id)` landed
      // between the handler's `findById()` and `save()` calls, the row no
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
        .run(resolvedDir, workspace.name.value, workspace.id.value);
      if (result.changes === 0) {
        throw new WorkspaceNotRegisteredError(workspace.id.value);
      }
    });
  }

  override async create(workspace: Workspace): Promise<void> {
    const resolvedDir = workspace.workspaceDir.value;

    this.runInTransaction(() => {
      const idConflict = this.db
        .prepare("SELECT 1 FROM workspaces WHERE id = ?")
        .get(workspace.id.value);
      if (idConflict !== undefined) {
        throw new WorkspaceIdConflictError(workspace.id.value);
      }
      const pathConflict = this.db
        .prepare("SELECT id FROM workspaces WHERE workspace_dir = ?")
        .get(resolvedDir) as { id: string } | undefined;
      if (pathConflict) {
        throw new WorkspacePathConflictError(resolvedDir, pathConflict.id);
      }
      this.db
        .prepare(
          `INSERT INTO workspaces (id, workspace_dir, name, created_at, registered_at, last_opened_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          workspace.id.value,
          resolvedDir,
          workspace.name.value,
          workspace.createdAt,
          new Date().toISOString(),
        );
    });
  }

  override async delete(id: WorkspaceId): Promise<void> {
    this.runInTransaction(() => {
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id.value);
      this.db
        .prepare("DELETE FROM global_state WHERE key = ? AND value = ?")
        .run(CURRENT_WORKSPACE_KEY, id.value);
    });
  }

  override async getCurrent(): Promise<string | null> {
    const row = this.db
      .prepare("SELECT value FROM global_state WHERE key = ?")
      .get(CURRENT_WORKSPACE_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  }

  override async setCurrent(id: WorkspaceId): Promise<void> {
    this.runInTransaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(id.value);
      if (exists === undefined) {
        throw new WorkspaceNotRegisteredError(id.value);
      }
      this.db
        .prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id.value);
      this.db
        .prepare(
          `INSERT INTO global_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(CURRENT_WORKSPACE_KEY, id.value);
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
  override close(): void {
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

  private assertSchema(): void {
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

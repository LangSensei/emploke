import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "@emploke/logger";
import {
  RegistrySchemaMismatchError,
  WorkspaceCorruptedError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../errors.js";
import { isValidWorkspaceId } from "../names.js";
import { Workspace, type WorkspaceDefaults } from "../workspace-entity.js";
import type { WorkspaceRepository } from "./repository.js";

const WORKSPACE_PKG_SCHEMA_VERSION = 1;

/** Key in `global_state` holding the current-workspace pointer. */
const CURRENT_WORKSPACE_KEY = "current_workspace_id";

interface WorkspaceRow {
  id: string;
  workdir: string;
  name: string;
  created_at: string;
  registered_at: string;
  last_opened_at: string | null;
  defaults_json: string;
}

/**
 * SQLite-backed `WorkspaceRepository`. Every workspace's complete
 * record — id, workdir, name, createdAt, defaults, plus
 * registry-only timing fields — lives in a single `workspaces` row
 * inside `<EMPLOKE_HOME>/global.db`. There is no per-workspace
 * metadata file (no `workspace.json`); a workspace folder contains
 * only emploke's per-workspace `workspace.db` plus agent-owned files.
 *
 * The earlier design split "registry" (`global.db`) from "metadata"
 * (`<workdir>/workspace.json`) under the assumption that a workspace
 * folder should be self-describing if copied to another machine.
 * In practice emploke is a server-centric tool — workspace folders
 * are agent workdirs, not portable bundles — and the split cost
 * `list()` an N+1 file-read fan-out for every dashboard refresh.
 * Consolidating into a single SQLite row makes `list()` one indexed
 * scan and removes the JSON sidecar entirely.
 */
export class SqliteWorkspaceRepository implements WorkspaceRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

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
        `SELECT id, workdir, name, created_at, registered_at, last_opened_at, defaults_json
         FROM workspaces ORDER BY registered_at`,
      )
      .all() as unknown as WorkspaceRow[];
    const out: Workspace[] = [];
    for (const row of rows) {
      try {
        out.push(rowToWorkspace(row));
      } catch (err) {
        this.logger.warn("workspaces: skipping corrupted row", {
          workspaceId: row.id,
          workdir: row.workdir,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  async read(id: string): Promise<Workspace | null> {
    if (!isValidWorkspaceId(id)) return null;
    const row = this.db
      .prepare(
        `SELECT id, workdir, name, created_at, registered_at, last_opened_at, defaults_json
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
    const resolvedWorkdir = path.resolve(workspace.workdir);
    const defaultsJson = workspace.defaults ? JSON.stringify(workspace.defaults) : "{}";

    this.runInTransaction(() => {
      // Path-conflict check stays for defence in depth — although
      // `WorkspaceManager.update` only flows through `withMetadata`
      // (which preserves workdir), the public repository contract
      // accepts an arbitrary `Workspace`, so a buggy caller could
      // still pass a colliding workdir.
      const conflict = this.db
        .prepare("SELECT id FROM workspaces WHERE workdir = ? AND id != ?")
        .get(resolvedWorkdir, workspace.id) as { id: string } | undefined;
      if (conflict) {
        throw new WorkspacePathConflictError(resolvedWorkdir, conflict.id);
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
              SET workdir = ?, name = ?, defaults_json = ?
              WHERE id = ?`,
        )
        .run(resolvedWorkdir, workspace.name, defaultsJson, workspace.id);
      if (result.changes === 0) {
        throw new WorkspaceNotRegisteredError(workspace.id);
      }
    });
  }

  async create(workspace: Workspace): Promise<void> {
    if (!isValidWorkspaceId(workspace.id)) {
      throw new WorkspaceIdInvalidError(workspace.id);
    }
    const resolvedWorkdir = path.resolve(workspace.workdir);
    const defaultsJson = workspace.defaults ? JSON.stringify(workspace.defaults) : "{}";

    this.runInTransaction(() => {
      const idConflict = this.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(workspace.id);
      if (idConflict !== undefined) {
        throw new WorkspaceIdConflictError(workspace.id);
      }
      const pathConflict = this.db
        .prepare("SELECT id FROM workspaces WHERE workdir = ?")
        .get(resolvedWorkdir) as { id: string } | undefined;
      if (pathConflict) {
        throw new WorkspacePathConflictError(resolvedWorkdir, pathConflict.id);
      }
      this.db
        .prepare(
          `INSERT INTO workspaces (id, workdir, name, created_at, registered_at, last_opened_at, defaults_json)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          workspace.id,
          resolvedWorkdir,
          workspace.name,
          workspace.createdAt,
          new Date().toISOString(),
          defaultsJson,
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
    // Bootstrap inside a single BEGIN IMMEDIATE so two concurrent
    // openers (e.g. server + future migration tool) serialise on the
    // file lock. Without it, both could SELECT existing === undefined
    // and the second INSERT would fail with PRIMARY KEY conflict
    // instead of recognising the table is already initialised.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          pkg     TEXT PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0)
        );
        CREATE TABLE IF NOT EXISTS workspaces (
          id              TEXT PRIMARY KEY NOT NULL,
          workdir         TEXT NOT NULL UNIQUE,
          name            TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          registered_at   TEXT NOT NULL,
          last_opened_at  TEXT,
          defaults_json   TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS global_state (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);
      const existing = this.db
        .prepare("SELECT version FROM schema_meta WHERE pkg = ?")
        .get("workspace") as { version: number } | undefined;
      if (existing === undefined) {
        this.db
          .prepare("INSERT INTO schema_meta (pkg, version) VALUES (?, ?)")
          .run("workspace", WORKSPACE_PKG_SCHEMA_VERSION);
      } else if (existing.version !== WORKSPACE_PKG_SCHEMA_VERSION) {
        throw new RegistrySchemaMismatchError(
          "global.db (workspace pkg)",
          existing.version,
          WORKSPACE_PKG_SCHEMA_VERSION,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  let defaults: WorkspaceDefaults | undefined;
  if (row.defaults_json && row.defaults_json !== "{}") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.defaults_json);
    } catch (err) {
      throw new WorkspaceCorruptedError(
        row.workdir,
        `defaults_json is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WorkspaceCorruptedError(row.workdir, "defaults_json must decode to an object");
    }
    const d = parsed as Record<string, unknown>;
    if (d.runtime !== undefined && typeof d.runtime !== "string") {
      throw new WorkspaceCorruptedError(row.workdir, "defaults.runtime must be a string");
    }
    if (d.agent !== undefined && typeof d.agent !== "string") {
      throw new WorkspaceCorruptedError(row.workdir, "defaults.agent must be a string");
    }
    defaults = {
      ...(typeof d.runtime === "string" ? { runtime: d.runtime } : {}),
      ...(typeof d.agent === "string" ? { agent: d.agent } : {}),
    };
  }
  return Workspace.fromStored({
    dir: row.workdir,
    id: row.id,
    workdir: row.workdir,
    name: row.name,
    createdAt: row.created_at,
    ...(defaults ? { defaults } : {}),
  });
}

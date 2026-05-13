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
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
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
      const conflict = this.db
        .prepare("SELECT id FROM workspaces WHERE workdir = ? AND id != ?")
        .get(resolvedWorkdir, workspace.id) as { id: string } | undefined;
      if (conflict) {
        throw new WorkspacePathConflictError(resolvedWorkdir, conflict.id);
      }
      // ON CONFLICT keeps registered_at + last_opened_at (registry-side
      // timing fields) from the existing row; caller-supplied metadata
      // (name, defaults) is overwritten as expected.
      this.db
        .prepare(
          `INSERT INTO workspaces (id, workdir, name, created_at, registered_at, last_opened_at, defaults_json)
           VALUES (?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET
             workdir = excluded.workdir,
             name = excluded.name,
             defaults_json = excluded.defaults_json`,
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
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private ensureSchema(): void {
    this.db.exec("BEGIN");
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
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

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
    throw new RegistrySchemaMismatchError(
      "global.db (workspace pkg)",
      existing.version,
      WORKSPACE_PKG_SCHEMA_VERSION,
    );
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

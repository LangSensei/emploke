import { DatabaseSync } from "node:sqlite";
import { runPkgMigrationsSync } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_MIGRATIONS } from "../../src/migrations/index.js";

/**
 * End-to-end test for the task v3 → v4 migration (issue #119).
 *
 * Seeds a populated v3 schema directly via SQL (bypassing the
 * repository, which now expects v4), runs the migration chain through
 * the coordinator, and asserts the v4 state:
 *
 *   - status enum normalised to all-adjective form
 *   - `success` / `failure` / `cancellation` JSON columns populated
 *     correctly for each terminal status
 *   - `origin` column added with `'standalone'` default for legacy
 *     rows
 *   - `started_at` tightened to NOT NULL (COALESCE-backfilled from
 *     `created_at` for any rare row that was missing it)
 *   - legacy flat columns (`result_output`, `failure_*`,
 *     `cancellation_*`) dropped
 *   - new indexes (`idx_tasks_origin`, `idx_tasks_status_origin`,
 *     `idx_tasks_status`, `idx_tasks_runtime`, `idx_tasks_agent`,
 *     `idx_tasks_created_at`) present
 *   - `schema_meta(pkg='task').version` bumped to 4
 */
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

function seedV3Schema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE schema_meta (
      pkg     TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );
    CREATE TABLE tasks (
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
      metadata        TEXT NOT NULL DEFAULT '{}',
      failure_kind         TEXT,
      failure_exit_code    INTEGER,
      failure_signal       TEXT,
      cancellation_kind    TEXT,
      cancellation_message TEXT
    );
    CREATE INDEX tasks_status_idx     ON tasks(status);
    CREATE INDEX tasks_runtime_idx    ON tasks(runtime);
    CREATE INDEX tasks_agent_idx      ON tasks(agent);
    CREATE INDEX tasks_created_at_idx ON tasks(created_at);
    INSERT INTO schema_meta (pkg, version) VALUES ('task', 3);
  `);
}

function runMigrations(d: DatabaseSync) {
  return runPkgMigrationsSync(d, [{ pkg: "task", migrations: TASK_MIGRATIONS }]);
}

describe("task v3 → v4 migration (issue #119) — schema shape", () => {
  it("collapses flat columns into JSON, normalises status, adds origin, bumps version", () => {
    seedV3Schema(db);

    // One row per terminal status + one running row.
    db.prepare(
      `INSERT INTO tasks (
        id, agent, runtime, status, brief, details, created_at, started_at,
        ended_at, result_output, failure_error, metadata,
        failure_kind, failure_exit_code, failure_signal,
        cancellation_kind, cancellation_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-aaaaaaaa", "writer", "copilot",
      "success", // → succeeded
      "do the thing", "details body",
      "2026-05-18T00:00:00.000Z", "2026-05-18T00:00:01.000Z", "2026-05-18T00:00:05.000Z",
      "all done", null, '{"pid":1234}',
      null, null, null, null, null,
    );
    db.prepare(
      `INSERT INTO tasks (
        id, agent, runtime, status, brief, details, created_at, started_at,
        ended_at, result_output, failure_error, metadata,
        failure_kind, failure_exit_code, failure_signal,
        cancellation_kind, cancellation_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-bbbbbbbb", "writer", "copilot",
      "failure", // → failed
      "bad task", null,
      "2026-05-18T01:00:00.000Z", "2026-05-18T01:00:01.000Z", "2026-05-18T01:00:03.000Z",
      null, "boom", "{}",
      "exited", 137, null, null, null,
    );
    db.prepare(
      `INSERT INTO tasks (
        id, agent, runtime, status, brief, details, created_at, started_at,
        ended_at, result_output, failure_error, metadata,
        failure_kind, failure_exit_code, failure_signal,
        cancellation_kind, cancellation_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-cccccccc", "writer", "copilot",
      "failure", // signal variant
      "killed task", null,
      "2026-05-18T02:00:00.000Z", "2026-05-18T02:00:01.000Z", "2026-05-18T02:00:02.000Z",
      null, "received SIGTERM", "{}",
      "signal", null, "SIGTERM", null, null,
    );
    db.prepare(
      `INSERT INTO tasks (
        id, agent, runtime, status, brief, details, created_at, started_at,
        ended_at, result_output, failure_error, metadata,
        failure_kind, failure_exit_code, failure_signal,
        cancellation_kind, cancellation_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-dddddddd", "writer", "copilot",
      "cancelled",
      "cancelled task", null,
      "2026-05-18T03:00:00.000Z", "2026-05-18T03:00:01.000Z", "2026-05-18T03:00:04.000Z",
      null, null, "{}",
      null, null, null, "user", "user requested",
    );
    // Running row (no terminal payload at all)
    db.prepare(
      `INSERT INTO tasks (
        id, agent, runtime, status, brief, details, created_at, started_at,
        ended_at, result_output, failure_error, metadata,
        failure_kind, failure_exit_code, failure_signal,
        cancellation_kind, cancellation_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-eeeeeeee", "writer", "copilot",
      "running",
      "live task", null,
      "2026-05-18T04:00:00.000Z", "2026-05-18T04:00:01.000Z", null,
      null, null, "{}",
      null, null, null, null, null,
    );
    // Legacy v2-shape failed row (failure_kind NULL, only failure_error).
    db.prepare(
      `INSERT INTO tasks (
        id, agent, runtime, status, brief, details, created_at, started_at,
        ended_at, result_output, failure_error, metadata,
        failure_kind, failure_exit_code, failure_signal,
        cancellation_kind, cancellation_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-ffffffff", "writer", "copilot",
      "failure",
      "legacy fail", null,
      "2026-05-18T05:00:00.000Z", "2026-05-18T05:00:01.000Z", "2026-05-18T05:00:02.000Z",
      null, "legacy v2 boom", "{}",
      null, null, null, null, null,
    );
    // Edge: row with started_at NULL — should be COALESCEd to created_at.
    db.prepare(
      `INSERT INTO tasks (
        id, agent, runtime, status, brief, details, created_at, started_at,
        ended_at, result_output, failure_error, metadata,
        failure_kind, failure_exit_code, failure_signal,
        cancellation_kind, cancellation_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-99999999", "writer", "copilot",
      "running",
      "no started_at", null,
      "2026-05-18T06:00:00.000Z", null, null,
      null, null, "{}",
      null, null, null, null, null,
    );

    runMigrations(db);

    // schema_meta bumped 3 → 4.
    const ver = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as {
      version: number;
    };
    expect(ver.version).toBe(4);

    // Column shape: 14 first-class columns; no legacy flat ones.
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols.sort()).toEqual(
      [
        "id",
        "agent",
        "runtime",
        "brief",
        "details",
        "origin",
        "status",
        "success",
        "failure",
        "cancellation",
        "created_at",
        "started_at",
        "ended_at",
        "metadata",
      ].sort(),
    );

    // Succeeded row: success JSON populated, failure / cancellation NULL.
    const succeeded = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-aaaaaaaa") as {
      status: string;
      origin: string;
      success: string;
      failure: string | null;
      cancellation: string | null;
    };
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.origin).toBe("standalone");
    expect(JSON.parse(succeeded.success)).toEqual({ output: "all done" });
    expect(succeeded.failure).toBeNull();
    expect(succeeded.cancellation).toBeNull();

    // Failed (exited) row.
    const exited = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-bbbbbbbb") as {
      status: string;
      success: string | null;
      failure: string;
      cancellation: string | null;
    };
    expect(exited.status).toBe("failed");
    expect(exited.success).toBeNull();
    expect(JSON.parse(exited.failure)).toEqual({
      kind: "exited",
      message: "boom",
      exitCode: 137,
      signal: null,
    });
    expect(exited.cancellation).toBeNull();

    // Failed (signal) row.
    const signal = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-cccccccc") as {
      failure: string;
    };
    expect(JSON.parse(signal.failure)).toEqual({
      kind: "signal",
      message: "received SIGTERM",
      exitCode: null,
      signal: "SIGTERM",
    });

    // Cancelled row.
    const cancelled = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-dddddddd") as {
      status: string;
      cancellation: string;
    };
    expect(cancelled.status).toBe("cancelled");
    expect(JSON.parse(cancelled.cancellation)).toEqual({ kind: "user", message: "user requested" });

    // Running row: terminal columns all NULL.
    const running = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-eeeeeeee") as {
      status: string;
      success: string | null;
      failure: string | null;
      cancellation: string | null;
    };
    expect(running.status).toBe("running");
    expect(running.success).toBeNull();
    expect(running.failure).toBeNull();
    expect(running.cancellation).toBeNull();

    // Legacy v2-shape failed row (failure_kind NULL) → synthesised as
    // kind:'internal'.
    const legacy = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-ffffffff") as {
      failure: string;
    };
    expect(JSON.parse(legacy.failure)).toEqual({
      kind: "internal",
      message: "legacy v2 boom",
      exitCode: null,
      signal: null,
    });

    // started_at backfill via COALESCE.
    const noStart = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-99999999") as {
      created_at: string;
      started_at: string;
    };
    expect(noStart.started_at).toBe(noStart.created_at);

    // Indexes present.
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const expected of [
      "idx_tasks_origin",
      "idx_tasks_status",
      "idx_tasks_status_origin",
      "idx_tasks_runtime",
      "idx_tasks_agent",
      "idx_tasks_created_at",
    ]) {
      expect(indexes).toContain(expected);
    }
  });

  it("idempotent: re-running against an already-v4 DB applies no migrations", () => {
    seedV3Schema(db);
    runMigrations(db);
    const result = runMigrations(db);
    expect(result.applied).toEqual([]);
    expect(result.alreadyAtTarget).toEqual(["task"]);
  });

  it("CHECK constraint rejects invalid status values post-migration", () => {
    seedV3Schema(db);
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, agent, brief, status, origin, created_at, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "20260518-bad-stat",
          "writer",
          "x",
          "success", // old enum, now invalid
          "standalone",
          new Date().toISOString(),
          new Date().toISOString(),
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("walks v2 → v3 → v4 in sequence on a fresh v2 DB", () => {
    // Seed a v2 schema directly (the shape before v2→v3 added the
    // failure_*/cancellation_* columns).
    db.exec(`
      CREATE TABLE schema_meta (
        pkg     TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0)
      );
      CREATE TABLE tasks (
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
      INSERT INTO schema_meta (pkg, version) VALUES ('task', 2);
    `);
    db.prepare(
      `INSERT INTO tasks (id, agent, runtime, status, brief, details, created_at, started_at, ended_at, result_output, failure_error, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-v2v2v2v2",
      "writer",
      "copilot",
      "failure",
      "old v2 task",
      null,
      "2026-05-18T00:00:00.000Z",
      "2026-05-18T00:00:01.000Z",
      "2026-05-18T00:00:02.000Z",
      null,
      "v2 boom",
      "{}",
    );

    const result = runMigrations(db);
    expect(result.applied.map((m) => `${m.fromVersion}→${m.toVersion}`)).toEqual([
      "2→3",
      "3→4",
    ]);

    const ver = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as {
      version: number;
    };
    expect(ver.version).toBe(4);

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-v2v2v2v2") as {
      status: string;
      failure: string;
    };
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.failure)).toEqual({
      kind: "internal",
      message: "v2 boom",
      exitCode: null,
      signal: null,
    });
  });
});

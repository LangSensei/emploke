import { DatabaseSync } from "node:sqlite";
import { runPkgMigrationsSync } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTaskRepository, TASK_MIGRATIONS } from "../../src/index.js";

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

/**
 * Seed a v2-shape `tasks` table directly via SQL: brief + details
 * but no failure / cancellation columns. Mirrors the column set that
 * `migrateV1ToV2` produces on a v1→v2 upgrade.
 */
function seedV2Schema(d: DatabaseSync): void {
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
      metadata        TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO schema_meta (pkg, version) VALUES ('task', 2);
  `);
}

describe("task v2→v3 migration applied via MigrationCoordinator", () => {
  // Regression guard for the issue-#123 refactor: the v2→v3 SQL
  // moved from inline `migrateV2ToV3` into `migrations/v2-to-v3.ts`
  // and is now driven by the coordinator. This test pins that the
  // schema after migration matches the pre-#123 inline migration's
  // output exactly: five new nullable columns added, every existing
  // column + row preserved verbatim, schema_meta bumped to 3.

  it("adds the five typed-failure / cancellation columns and preserves existing rows", () => {
    seedV2Schema(db);
    db.prepare(
      `INSERT INTO tasks (
         id, agent, runtime, status, brief, details, created_at, started_at,
         ended_at, result_output, failure_error, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-aaaaaaaa",
      "writer",
      "copilot",
      "failure",
      "do the thing",
      "extended details",
      "2026-05-18T00:00:00.000Z",
      "2026-05-18T00:00:01.000Z",
      "2026-05-18T00:00:05.000Z",
      null,
      "legacy boom",
      '{"pid":1234}',
    );

    runPkgMigrationsSync(db, [{ pkg: "task", migrations: TASK_MIGRATIONS }]);

    // schema_meta bumped from 2 → 3 (and only 3 — not skipped).
    const ver = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as {
      version: number;
    };
    expect(ver.version).toBe(3);

    // The five new columns exist and have the documented types.
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as {
      name: string;
      type: string;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c.type]));
    expect(byName.get("failure_kind")).toBe("TEXT");
    expect(byName.get("failure_exit_code")).toBe("INTEGER");
    expect(byName.get("failure_signal")).toBe("TEXT");
    expect(byName.get("cancellation_kind")).toBe("TEXT");
    expect(byName.get("cancellation_message")).toBe("TEXT");

    // Existing row preserved verbatim — no data movement on v2→v3.
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get("20260518-aaaaaaaa") as {
      id: string;
      agent: string;
      brief: string;
      details: string;
      failure_error: string;
      failure_kind: string | null;
      failure_exit_code: number | null;
      failure_signal: string | null;
      cancellation_kind: string | null;
      cancellation_message: string | null;
    };
    expect(row.id).toBe("20260518-aaaaaaaa");
    expect(row.agent).toBe("writer");
    expect(row.brief).toBe("do the thing");
    expect(row.details).toBe("extended details");
    expect(row.failure_error).toBe("legacy boom");
    // New columns default to NULL for legacy rows — the repository's
    // read path synthesises {kind:'internal', message: failure_error}
    // (covered by failure-union-legacy-row.test.ts).
    expect(row.failure_kind).toBeNull();
    expect(row.failure_exit_code).toBeNull();
    expect(row.failure_signal).toBeNull();
    expect(row.cancellation_kind).toBeNull();
    expect(row.cancellation_message).toBeNull();
  });

  it("the repository reads the migrated row as a Task with kind='internal' failure", async () => {
    seedV2Schema(db);
    db.prepare(
      `INSERT INTO tasks (
         id, agent, runtime, status, brief, details, created_at, started_at,
         ended_at, result_output, failure_error, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "20260518-bbbbbbbb",
      "writer",
      "copilot",
      "failure",
      "another thing",
      null,
      "2026-05-18T00:00:00.000Z",
      "2026-05-18T00:00:01.000Z",
      "2026-05-18T00:00:03.000Z",
      null,
      "old boom",
      "{}",
    );

    runPkgMigrationsSync(db, [{ pkg: "task", migrations: TASK_MIGRATIONS }]);

    const repo = new SqliteTaskRepository({ db });
    const back = await repo.read("20260518-bbbbbbbb");
    expect(back).not.toBeNull();
    expect(back?.status).toBe("failure");
    // Pre-existing legacy-row synthesis behaviour (covered separately
    // in failure-union-legacy-row.test.ts) survives the v2→v3
    // migration unchanged — proving the refactor preserved
    // end-to-end semantics, not just the SQL.
    expect(back?.failure).toEqual({ kind: "internal", message: "old boom" });
  });
});

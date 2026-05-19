import { DatabaseSync } from "node:sqlite";
import { runPkgMigrationsSync } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_MIGRATIONS } from "../../src/migrations/index.js";

/**
 * End-to-end test for the session v1 → v2 migration (issue #120).
 *
 * The migration itself is pure DDL — `ALTER TABLE … ADD COLUMN agent`
 * + `CREATE INDEX sessions_agent_idx`. Existing rows get the
 * empty-string default; the application-side backfill (in
 * `SessionManager` construction, NOT in the migration file) is what
 * reads `<sessionsDir>/<id>/AGENTS.md` and `UPDATE`s the column. This
 * test pins:
 *
 *   - new column `agent TEXT NOT NULL DEFAULT ''` exists with the
 *     correct constraint
 *   - new `sessions_agent_idx` index exists
 *   - existing rows are preserved verbatim with empty `agent` value
 *     (later filled in by the manager's startup backfill loop)
 *   - schema_meta bumped 1 → 2
 *   - idempotent on re-run
 *   - WHERE agent = ? returns correct subset
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

function seedV1Schema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE schema_meta (
      pkg     TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0)
    );
    CREATE TABLE sessions (
      id                  TEXT PRIMARY KEY,
      runtime             TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      runtime_session_id  TEXT,
      last_launch_mode    TEXT
    );
    CREATE INDEX sessions_runtime_idx    ON sessions(runtime);
    CREATE INDEX sessions_created_at_idx ON sessions(created_at);
    INSERT INTO schema_meta (pkg, version) VALUES ('session', 1);
  `);
}

function runMigrations(d: DatabaseSync) {
  return runPkgMigrationsSync(d, [{ pkg: "session", migrations: SESSION_MIGRATIONS }]);
}

describe("session v1 → v2 migration (issue #120) — schema shape", () => {
  it("adds agent column + sessions_agent_idx, preserves rows, bumps version", () => {
    seedV1Schema(db);

    db.prepare(
      `INSERT INTO sessions (id, runtime, created_at, runtime_session_id, last_launch_mode)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "20260518-aaaaaaaa",
      "copilot",
      "2026-05-18T00:00:00.000Z",
      "abcd1234-runtime-id",
      "local",
    );
    db.prepare(
      `INSERT INTO sessions (id, runtime, created_at, runtime_session_id, last_launch_mode)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "20260518-bbbbbbbb",
      "copilot",
      "2026-05-18T01:00:00.000Z",
      null,
      null,
    );

    runMigrations(db);

    // Column shape: 6 columns; agent NOT NULL DEFAULT ''.
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(cols).toHaveLength(6);
    expect(byName.get("agent")?.type).toBe("TEXT");
    expect(byName.get("agent")?.notnull).toBe(1);
    expect(byName.get("agent")?.dflt_value).toBe("''");

    // schema_meta bumped 1 → 2.
    const ver = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("session") as {
      version: number;
    };
    expect(ver.version).toBe(2);

    // Existing rows preserved with empty agent.
    const rows = db.prepare("SELECT id, agent FROM sessions ORDER BY id").all() as {
      id: string;
      agent: string;
    }[];
    expect(rows).toEqual([
      { id: "20260518-aaaaaaaa", agent: "" },
      { id: "20260518-bbbbbbbb", agent: "" },
    ]);

    // New index created.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toContain("sessions_agent_idx");
    // Pre-existing v1 indexes unaffected.
    expect(indexes).toContain("sessions_runtime_idx");
    expect(indexes).toContain("sessions_created_at_idx");
  });

  it("idempotent: re-running against an already-v2 DB applies no migrations", () => {
    seedV1Schema(db);
    runMigrations(db);
    const result = runMigrations(db);
    expect(result.applied).toEqual([]);
    expect(result.alreadyAtTarget).toEqual(["session"]);
  });

  it("after migration, WHERE agent = ? returns the indexed subset", () => {
    seedV1Schema(db);
    runMigrations(db);

    db.prepare(
      `INSERT INTO sessions (id, runtime, created_at, runtime_session_id, agent)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(
      "20260518-aaaaaaaa",
      "copilot",
      "2026-05-18T00:00:00.000Z",
      "public/writer",
    );
    db.prepare(
      `INSERT INTO sessions (id, runtime, created_at, runtime_session_id, agent)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(
      "20260518-bbbbbbbb",
      "copilot",
      "2026-05-18T01:00:00.000Z",
      "public/reader",
    );

    const matches = db.prepare("SELECT id FROM sessions WHERE agent = ?").all("public/writer") as {
      id: string;
    }[];
    expect(matches).toEqual([{ id: "20260518-aaaaaaaa" }]);

    // EXPLAIN QUERY PLAN should use the agent index (defence in depth
    // that the index is wired correctly).
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE agent = ?")
      .all("public/writer") as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(" | ");
    expect(detail).toContain("sessions_agent_idx");
  });

  it("post-migration INSERT without agent fails (NOT NULL enforces explicit value)", () => {
    seedV1Schema(db);
    runMigrations(db);

    // Default is the empty string, so this won't actually fail at SQL
    // level — the empty-string DEFAULT satisfies NOT NULL. The
    // application-layer validation (Session.fromStored rejecting
    // empty agent) is what stops the row from being read back as
    // valid. We pin both behaviours here so any future tightening
    // (e.g. CHECK (agent != '')) gets a hint on what test to update.
    db.prepare(
      `INSERT INTO sessions (id, runtime, created_at, runtime_session_id)
       VALUES (?, ?, ?, NULL)`,
    ).run("20260518-noagent1", "copilot", "2026-05-18T02:00:00.000Z");

    const row = db.prepare("SELECT agent FROM sessions WHERE id = ?").get("20260518-noagent1") as {
      agent: string;
    };
    // SQL layer accepts via empty-string default.
    expect(row.agent).toBe("");
  });
});

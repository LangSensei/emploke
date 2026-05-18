import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureLogger } from "@emploke/logger/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CorruptedTaskError,
  InvalidTaskIdError,
  SqliteTaskRepository,
  Task,
  type TaskStatus,
} from "../src/index.js";

let scratchDir: string;
let db: DatabaseSync;
let repo: SqliteTaskRepository;

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "emploke-sqlite-task-"));
  db = new DatabaseSync(":memory:");
  repo = new SqliteTaskRepository({ db });
});
afterEach(async () => {
  try {
    db.close();
  } catch {
    // already closed
  }
  await rm(scratchDir, { recursive: true, force: true });
});

const ID = "20260509-aabbccdd";
const CREATED_AT = "2026-05-09T01:00:00.000Z";

/**
 * Build a Task in any status — `Task.fromStored` is the only public
 * factory that lets the test stand a task up directly in `running` /
 * `success` / `failure` / `cancelled` without going through the
 * transition methods. That's exactly its job: rehydrating from
 * storage. We use it here as a test-shape factory because the
 * storage seam is what the repository tests are about.
 */
function makeTask(
  overrides: {
    id?: string;
    agent?: string;
    brief?: string;
    details?: string;
    status?: TaskStatus;
    metadata?: Readonly<Record<string, unknown>>;
    createdAt?: string;
    startedAt?: string;
    endedAt?: string;
    result?: { output: string };
    failure?: import("../src/types.js").TaskFailure;
    cancellation?: import("../src/types.js").TaskCancellation;
  } = {},
): Task {
  return Task.fromStored({
    id: overrides.id ?? ID,
    agent: overrides.agent ?? "writer",
    brief: overrides.brief ?? "do the thing",
    ...(overrides.details !== undefined ? { details: overrides.details } : {}),
    status: overrides.status ?? "running",
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? CREATED_AT,
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.endedAt !== undefined ? { endedAt: overrides.endedAt } : {}),
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    ...(overrides.failure !== undefined ? { failure: overrides.failure } : {}),
    ...(overrides.cancellation !== undefined ? { cancellation: overrides.cancellation } : {}),
  });
}

describe("SqliteTaskRepository", () => {
  it("save + read round-trip preserves all base fields", async () => {
    const sample = makeTask();
    await repo.save(sample);
    const back = await repo.read(ID);
    expect(back?.toJSON()).toEqual(sample.toJSON());
  });

  it("save + read round-trips details when present", async () => {
    const sample = makeTask({ details: "first line\nsecond line\n你好" });
    await repo.save(sample);
    const back = await repo.read(ID);
    expect(back?.details).toBe("first line\nsecond line\n你好");
  });

  it("save + read leaves details undefined when not provided", async () => {
    await repo.save(makeTask());
    const back = await repo.read(ID);
    expect(back?.details).toBeUndefined();
  });

  it("read returns null for missing id", async () => {
    expect(await repo.read("20260509-deadbeef")).toBeNull();
  });

  it("save promotes metadata.runtime to first-class column", async () => {
    await repo.save(makeTask({ metadata: { runtime: "gemini", pid: 1234 } }));
    const back = await repo.read(ID);
    expect(back?.metadata).toEqual({ runtime: "gemini", pid: 1234 });
    expect(await repo.list({ runtime: "gemini" })).toHaveLength(1);
    expect(await repo.list({ runtime: "copilot" })).toHaveLength(0);
  });

  it("save handles tasks with empty metadata (runtime column = NULL)", async () => {
    await repo.save(makeTask());
    const back = await repo.read(ID);
    expect(back?.metadata).toEqual({});
    expect(await repo.list({ runtime: "anything" })).toHaveLength(0);
  });

  it("save preserves optional terminal fields (result, failure, cancellation, started/ended)", async () => {
    const success = makeTask({
      status: "success",
      startedAt: "2026-05-09T01:00:01.000Z",
      endedAt: "2026-05-09T01:00:05.000Z",
      result: { output: "all good" },
    });
    await repo.save(success);
    expect((await repo.read(ID))?.toJSON()).toEqual(success.toJSON());

    const failure = makeTask({
      status: "failure",
      startedAt: "2026-05-09T01:00:01.000Z",
      endedAt: "2026-05-09T01:00:03.000Z",
      failure: { kind: "exited", exitCode: 17, message: "exited with code 17" },
    });
    await repo.save(failure);
    expect((await repo.read(ID))?.toJSON()).toEqual(failure.toJSON());

    const cancelled = makeTask({
      status: "cancelled",
      startedAt: "2026-05-09T01:00:01.000Z",
      endedAt: "2026-05-09T01:00:03.000Z",
      cancellation: { kind: "user", message: "cancelled by user" },
    });
    await repo.save(cancelled);
    expect((await repo.read(ID))?.toJSON()).toEqual(cancelled.toJSON());
  });

  it("save is idempotent (INSERT OR REPLACE)", async () => {
    await repo.save(makeTask());
    await repo.save(makeTask({ status: "success", result: { output: "done" } }));
    const back = await repo.read(ID);
    expect(back?.status).toBe("success");
    expect(back?.result?.output).toBe("done");
  });

  it("delete removes the row; subsequent read returns null", async () => {
    await repo.save(makeTask());
    await repo.delete(ID);
    expect(await repo.read(ID)).toBeNull();
  });

  it("delete is idempotent for missing id", async () => {
    await repo.delete("20260101-cccccccc");
  });

  it("read/save reject malformed ids with InvalidTaskIdError", async () => {
    await expect(repo.read("../../etc/passwd")).rejects.toBeInstanceOf(InvalidTaskIdError);
    // `Task.fromStored` rejects malformed ids before construction —
    // the test asserts the bad-id rejection at the entity boundary.
    expect(() => makeTask({ id: "../../etc" })).toThrow(InvalidTaskIdError);
  });

  it("delete with malformed id is a silent no-op", async () => {
    await repo.save(makeTask());
    await repo.delete("../../etc/passwd");
    expect((await repo.read(ID))?.id).toBe(ID);
  });

  it("list filters by agent / status / createdSince / runtime", async () => {
    const a = makeTask({
      id: "20260101-aaaaaaaa",
      agent: "writer",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { runtime: "copilot" },
    });
    const b = makeTask({
      id: "20260601-bbbbbbbb",
      agent: "reviewer",
      status: "success",
      createdAt: "2026-06-01T00:00:00.000Z",
      metadata: { runtime: "gemini" },
    });
    await repo.save(a);
    await repo.save(b);

    expect((await repo.list()).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect((await repo.list({ agent: "writer" })).map((t) => t.id)).toEqual([a.id]);
    expect((await repo.list({ statuses: ["success"] })).map((t) => t.id)).toEqual([b.id]);
    expect(
      (await repo.list({ createdSince: "2026-03-01T00:00:00.000Z" })).map((t) => t.id),
    ).toEqual([b.id]);
    expect((await repo.list({ runtime: "gemini" })).map((t) => t.id)).toEqual([b.id]);
  });

  it("list with multiple statuses uses IN (...)", async () => {
    await repo.save(makeTask({ id: "20260101-aaaaaaaa", status: "running" }));
    await repo.save(makeTask({ id: "20260101-bbbbbbbb", status: "success" }));
    await repo.save(
      makeTask({
        id: "20260101-cccccccc",
        status: "failure",
        failure: { kind: "internal", message: "x" },
      }),
    );
    const r = await repo.list({ statuses: ["success", "failure"] });
    expect(r.map((t) => t.id).sort()).toEqual(["20260101-bbbbbbbb", "20260101-cccccccc"]);
  });

  it("rejects opening a workspace.db with a future schema version for the task pkg", async () => {
    // Bump the task pkg's row to a future version and re-construct.
    db.prepare("UPDATE schema_meta SET version = 999 WHERE pkg = ?").run("task");
    expect(() => new SqliteTaskRepository({ db })).toThrow(/schema mismatch/);
  });

  it("read throws CorruptedTaskError when metadata column is not valid JSON", async () => {
    // Regression: storage-side bit-rot in the JSON metadata column
    // must surface as a typed corruption, not silently degrade to {}.
    // Tampered/truncated rows could otherwise round-trip a valid-looking
    // task whose runtime metadata was lost on disk.
    await repo.save(makeTask());
    db.prepare("UPDATE tasks SET metadata = ? WHERE id = ?").run("not-json{", ID);
    await expect(repo.read(ID)).rejects.toBeInstanceOf(CorruptedTaskError);
  });

  it("read throws CorruptedTaskError when metadata decodes to a non-object root", async () => {
    await repo.save(makeTask());
    db.prepare("UPDATE tasks SET metadata = ? WHERE id = ?").run("[1,2,3]", ID);
    await expect(repo.read(ID)).rejects.toBeInstanceOf(CorruptedTaskError);
  });

  it("list silently skips rows with corrupted metadata and warns via the injected logger", async () => {
    // list() never throws on a single bad row — it logs + skips so the
    // dashboard can render every other task. This pins both halves of
    // that contract: the corrupted row is dropped AND a structured
    // warn is emitted carrying the offending taskId so operators can
    // find it without re-running the query manually.
    const { logger, entries } = captureLogger();
    const r = new SqliteTaskRepository({ db, logger });
    await r.save(makeTask({ id: "20260101-aaaaaaaa" }));
    await r.save(makeTask({ id: "20260101-bbbbbbbb" }));
    db.prepare("UPDATE tasks SET metadata = ? WHERE id = ?").run("not-json{", "20260101-bbbbbbbb");
    const all = await r.list();
    expect(all.map((t) => t.id)).toEqual(["20260101-aaaaaaaa"]);
    const warn = entries.find(
      (e) => e.level === 40 && e.msg === "tasks: skipping corrupted task row",
    );
    expect(warn).toBeDefined();
    expect(warn?.taskId).toBe("20260101-bbbbbbbb");
  });

  it("two separate :memory: connections are isolated", async () => {
    const dbA = new DatabaseSync(":memory:");
    const dbB = new DatabaseSync(":memory:");
    const a = new SqliteTaskRepository({ db: dbA });
    const b = new SqliteTaskRepository({ db: dbB });
    const sample = makeTask();
    await a.save(sample);
    expect((await a.read(ID))?.toJSON()).toEqual(sample.toJSON());
    expect(await b.read(ID)).toBeNull();
    dbA.close();
    dbB.close();
  });
});

describe("SqliteTaskRepository — v1 → v2 migration", () => {
  // Pre-1.0 hard cut: a v1 workspace.db with the old `instructions`
  // column is migrated in place to v2 (`brief` + `details`). The
  // brief is back-filled from the first 200 chars of `instructions`
  // (best-effort heuristic — v1 had no length cap, v2 enforces 200);
  // the full text is preserved verbatim in `details` so no user data
  // is lost.
  function seedV1Schema(d: DatabaseSync): void {
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
        instructions    TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        started_at      TEXT,
        ended_at        TEXT,
        result_output   TEXT,
        failure_error   TEXT,
        metadata        TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO schema_meta (pkg, version) VALUES ('task', 1);
    `);
  }

  it("migrates a short instructions row: brief = full instructions, details = full instructions", () => {
    const d = new DatabaseSync(":memory:");
    try {
      seedV1Schema(d);
      d.prepare(
        `INSERT INTO tasks (id, agent, runtime, status, instructions, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "20260101-aaaaaaaa",
        "writer",
        "copilot",
        "success",
        "Draft the post",
        "2026-01-01T00:00:00.000Z",
        "{}",
      );

      // Construction triggers ensureSchema → migrateV1ToV2 → migrateV2ToV3
      // (staged migration walks v1 all the way to current HEAD).
      const r = new SqliteTaskRepository({ db: d });
      const back = d
        .prepare("SELECT brief, details FROM tasks WHERE id = ?")
        .get("20260101-aaaaaaaa") as { brief: string; details: string };
      expect(back.brief).toBe("Draft the post");
      expect(back.details).toBe("Draft the post");

      // Schema version bumped to current HEAD (3).
      const v = d.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("task") as {
        version: number;
      };
      expect(v.version).toBe(3);

      // Read through the repo: full task entity is reconstructed.
      void r;
    } finally {
      d.close();
    }
  });

  it("migrates a long instructions row: brief truncated to 200, details preserved verbatim", () => {
    const d = new DatabaseSync(":memory:");
    try {
      seedV1Schema(d);
      const longText = `${"A".repeat(250)} END`; // 254 chars
      d.prepare(
        `INSERT INTO tasks (id, agent, runtime, status, instructions, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "20260101-bbbbbbbb",
        "writer",
        "copilot",
        "success",
        longText,
        "2026-01-01T00:00:00.000Z",
        "{}",
      );

      new SqliteTaskRepository({ db: d });
      const back = d
        .prepare("SELECT brief, details FROM tasks WHERE id = ?")
        .get("20260101-bbbbbbbb") as { brief: string; details: string };
      expect(back.brief.length).toBe(200);
      expect(back.brief).toBe("A".repeat(200));
      // Full original text preserved in details — no data loss.
      expect(back.details).toBe(longText);
    } finally {
      d.close();
    }
  });

  it("migrates an empty instructions row to brief='(untitled)' so the v2 entity invariant survives", () => {
    // v1 had no non-empty constraint on instructions (`TEXT NOT NULL`
    // accepts empty strings). v2 rejects empty briefs at the entity
    // boundary, so an empty migrated row would otherwise become
    // unreadable. Coerce to a placeholder so the row stays parseable;
    // the operator can rename / archive at leisure.
    const d = new DatabaseSync(":memory:");
    try {
      seedV1Schema(d);
      d.prepare(
        `INSERT INTO tasks (id, agent, runtime, status, instructions, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "20260101-cccccccc",
        "writer",
        "copilot",
        "success",
        "",
        "2026-01-01T00:00:00.000Z",
        "{}",
      );

      new SqliteTaskRepository({ db: d });
      const back = d
        .prepare("SELECT brief, details FROM tasks WHERE id = ?")
        .get("20260101-cccccccc") as { brief: string; details: string };
      expect(back.brief).toBe("(untitled)");
      expect(back.details).toBe("");
    } finally {
      d.close();
    }
  });

  it("preserves all non-instructions columns across migration", async () => {
    const d = new DatabaseSync(":memory:");
    try {
      seedV1Schema(d);
      d.prepare(
        `INSERT INTO tasks (
           id, agent, runtime, status, instructions, created_at, started_at,
           ended_at, result_output, failure_error, metadata
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "20260101-dddddddd",
        "writer",
        "copilot",
        "failure",
        "did the thing",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
        null,
        "boom",
        '{"pid":1234}',
      );

      const r = new SqliteTaskRepository({ db: d });
      const rows = await r.list();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.id).toBe("20260101-dddddddd");
      expect(row.agent).toBe("writer");
      expect(row.status).toBe("failure");
      expect(row.brief).toBe("did the thing");
      expect(row.details).toBe("did the thing");
      expect(row.startedAt).toBe("2026-01-01T00:00:01.000Z");
      expect(row.endedAt).toBe("2026-01-01T00:00:02.000Z");
      // Post-ADR-001: a row with failure_error but no failure_kind is
      // synthesised as `{ kind: 'internal', message }` (legacy fallback).
      expect(row.failure).toEqual({ kind: "internal", message: "boom" });
      expect(row.metadata).toEqual({ pid: 1234, runtime: "copilot" });
    } finally {
      d.close();
    }
  });
});

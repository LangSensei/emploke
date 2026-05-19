import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureLogger } from "@emploke/logger/testing";
import { runPkgMigrations } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CorruptedTaskError,
  InvalidTaskIdError,
  SqliteTaskRepository,
  TASK_MIGRATIONS,
  Task,
  type TaskOrigin,
  type TaskStatus,
} from "../src/index.js";

let scratchDir: string;
let db: DatabaseSync;
let repo: SqliteTaskRepository;

beforeEach(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "emploke-sqlite-task-"));
  db = new DatabaseSync(":memory:");
  await runPkgMigrations(db, [{ pkg: "task", migrations: TASK_MIGRATIONS }]);
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

function makeTask(
  overrides: {
    id?: string;
    agent?: string;
    brief?: string;
    details?: string;
    origin?: TaskOrigin;
    status?: TaskStatus;
    metadata?: Readonly<Record<string, unknown>>;
    createdAt?: string;
    startedAt?: string;
    endedAt?: string;
    success?: { output: string };
    failure?: import("../src/types.js").TaskFailure;
    cancellation?: import("../src/types.js").TaskCancellation;
  } = {},
): Task {
  return Task.fromStored({
    id: overrides.id ?? ID,
    agent: overrides.agent ?? "writer",
    brief: overrides.brief ?? "do the thing",
    ...(overrides.details !== undefined ? { details: overrides.details } : {}),
    origin: overrides.origin ?? "standalone",
    status: overrides.status ?? "running",
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? CREATED_AT,
    startedAt: overrides.startedAt ?? CREATED_AT,
    ...(overrides.endedAt !== undefined ? { endedAt: overrides.endedAt } : {}),
    ...(overrides.success !== undefined ? { success: overrides.success } : {}),
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

  it("save preserves the origin column", async () => {
    await repo.save(makeTask({ origin: "workflow" }));
    const back = await repo.read(ID);
    expect(back?.origin).toBe("workflow");
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

  it("save preserves optional terminal fields (success, failure, cancellation, ended)", async () => {
    const succeeded = makeTask({
      status: "succeeded",
      endedAt: "2026-05-09T01:00:05.000Z",
      success: { output: "all good" },
    });
    await repo.save(succeeded);
    expect((await repo.read(ID))?.toJSON()).toEqual(succeeded.toJSON());

    const failed = makeTask({
      status: "failed",
      endedAt: "2026-05-09T01:00:03.000Z",
      failure: { kind: "exited", exitCode: 17, message: "exited with code 17" },
    });
    await repo.save(failed);
    expect((await repo.read(ID))?.toJSON()).toEqual(failed.toJSON());

    const cancelled = makeTask({
      status: "cancelled",
      endedAt: "2026-05-09T01:00:03.000Z",
      cancellation: { kind: "user", message: "cancelled by user" },
    });
    await repo.save(cancelled);
    expect((await repo.read(ID))?.toJSON()).toEqual(cancelled.toJSON());
  });

  it("save is idempotent (INSERT OR REPLACE)", async () => {
    await repo.save(makeTask());
    await repo.save(
      makeTask({ status: "succeeded", success: { output: "done" }, endedAt: CREATED_AT }),
    );
    const back = await repo.read(ID);
    expect(back?.status).toBe("succeeded");
    expect(back?.success?.output).toBe("done");
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
      startedAt: "2026-01-01T00:00:00.000Z",
      metadata: { runtime: "copilot" },
    });
    const b = makeTask({
      id: "20260601-bbbbbbbb",
      agent: "reviewer",
      status: "succeeded",
      createdAt: "2026-06-01T00:00:00.000Z",
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: "2026-06-01T00:00:01.000Z",
      success: { output: "" },
      metadata: { runtime: "gemini" },
    });
    await repo.save(a);
    await repo.save(b);

    expect((await repo.list()).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect((await repo.list({ agent: "writer" })).map((t) => t.id)).toEqual([a.id]);
    expect((await repo.list({ statuses: ["succeeded"] })).map((t) => t.id)).toEqual([b.id]);
    expect(
      (await repo.list({ createdSince: "2026-03-01T00:00:00.000Z" })).map((t) => t.id),
    ).toEqual([b.id]);
    expect((await repo.list({ runtime: "gemini" })).map((t) => t.id)).toEqual([b.id]);
  });

  it("list with multiple statuses uses IN (...)", async () => {
    await repo.save(makeTask({ id: "20260101-aaaaaaaa", status: "running" }));
    await repo.save(
      makeTask({
        id: "20260101-bbbbbbbb",
        status: "succeeded",
        endedAt: CREATED_AT,
        success: { output: "" },
      }),
    );
    await repo.save(
      makeTask({
        id: "20260101-cccccccc",
        status: "failed",
        endedAt: CREATED_AT,
        failure: { kind: "internal", message: "x" },
      }),
    );
    const r = await repo.list({ statuses: ["succeeded", "failed"] });
    expect(r.map((t) => t.id).sort()).toEqual(["20260101-bbbbbbbb", "20260101-cccccccc"]);
  });

  it("rejects opening a workspace.db with a future schema version for the task pkg", async () => {
    db.prepare("UPDATE schema_meta SET version = 999 WHERE pkg = ?").run("task");
    expect(() => new SqliteTaskRepository({ db })).toThrow(/schema mismatch/);
  });

  it("read throws CorruptedTaskError when metadata column is not valid JSON", async () => {
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
    await runPkgMigrations(dbA, [{ pkg: "task", migrations: TASK_MIGRATIONS }]);
    await runPkgMigrations(dbB, [{ pkg: "task", migrations: TASK_MIGRATIONS }]);
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTaskIdError, SqliteTaskRepository, type Task } from "../src/index.js";

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
const sample: Task = {
  id: ID,
  agent: "writer",
  instructions: "do the thing",
  status: "running",
  metadata: {},
  createdAt: "2026-05-09T01:00:00.000Z",
};

describe("SqliteTaskRepository", () => {
  it("save + read round-trip preserves all base fields", async () => {
    await repo.save(sample);
    const back = await repo.read(ID);
    expect(back).toEqual(sample);
  });

  it("read returns null for missing id", async () => {
    expect(await repo.read("20260509-deadbeef")).toBeNull();
  });

  it("save promotes metadata.runtime to first-class column", async () => {
    await repo.save({ ...sample, metadata: { runtime: "gemini", pid: 1234 } });
    const back = await repo.read(ID);
    expect(back?.metadata).toEqual({ runtime: "gemini", pid: 1234 });
    expect(await repo.list({ runtime: "gemini" })).toHaveLength(1);
    expect(await repo.list({ runtime: "copilot" })).toHaveLength(0);
  });

  it("save handles tasks with empty metadata (runtime column = NULL)", async () => {
    await repo.save(sample);
    const back = await repo.read(ID);
    expect(back?.metadata).toEqual({});
    expect(await repo.list({ runtime: "anything" })).toHaveLength(0);
  });

  it("save preserves optional terminal fields (result.output, failure.error, started/ended)", async () => {
    const success: Task = {
      ...sample,
      status: "success",
      startedAt: "2026-05-09T01:00:01.000Z",
      endedAt: "2026-05-09T01:00:05.000Z",
      result: { output: "all good" },
    };
    await repo.save(success);
    expect(await repo.read(ID)).toEqual(success);

    const failure: Task = {
      ...sample,
      status: "failure",
      startedAt: "2026-05-09T01:00:01.000Z",
      endedAt: "2026-05-09T01:00:03.000Z",
      failure: { error: "boom" },
    };
    await repo.save(failure);
    expect(await repo.read(ID)).toEqual(failure);
  });

  it("save is idempotent (INSERT OR REPLACE)", async () => {
    await repo.save(sample);
    await repo.save({ ...sample, status: "success", result: { output: "done" } });
    const back = await repo.read(ID);
    expect(back?.status).toBe("success");
    expect(back?.result?.output).toBe("done");
  });

  it("delete removes the row; subsequent read returns null", async () => {
    await repo.save(sample);
    await repo.delete(ID);
    expect(await repo.read(ID)).toBeNull();
  });

  it("delete is idempotent for missing id", async () => {
    await repo.delete("20260101-cccccccc");
  });

  it("read/save reject malformed ids with InvalidTaskIdError", async () => {
    await expect(repo.read("../../etc/passwd")).rejects.toBeInstanceOf(InvalidTaskIdError);
    await expect(repo.save({ ...sample, id: "../../etc" })).rejects.toBeInstanceOf(
      InvalidTaskIdError,
    );
  });

  it("delete with malformed id is a silent no-op", async () => {
    await repo.save(sample);
    await repo.delete("../../etc/passwd");
    expect((await repo.read(ID))?.id).toBe(ID);
  });

  it("list filters by agent / status / createdSince / runtime", async () => {
    const a: Task = {
      ...sample,
      id: "20260101-aaaaaaaa",
      agent: "writer",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { runtime: "copilot" },
    };
    const b: Task = {
      ...sample,
      id: "20260601-bbbbbbbb",
      agent: "reviewer",
      status: "success",
      createdAt: "2026-06-01T00:00:00.000Z",
      metadata: { runtime: "gemini" },
    };
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
    await repo.save({ ...sample, id: "20260101-aaaaaaaa", status: "running" });
    await repo.save({ ...sample, id: "20260101-bbbbbbbb", status: "success" });
    await repo.save({ ...sample, id: "20260101-cccccccc", status: "failure" });
    const r = await repo.list({ statuses: ["success", "failure"] });
    expect(r.map((t) => t.id).sort()).toEqual(["20260101-bbbbbbbb", "20260101-cccccccc"]);
  });

  it("rejects opening a workspace.db with a future schema version for the task pkg", async () => {
    // Bump the task pkg's row to a future version and re-construct.
    db.prepare("UPDATE schema_meta SET version = 999 WHERE pkg = ?").run("task");
    expect(() => new SqliteTaskRepository({ db })).toThrow(/schema mismatch/);
  });

  it("two separate :memory: connections are isolated", async () => {
    const dbA = new DatabaseSync(":memory:");
    const dbB = new DatabaseSync(":memory:");
    const a = new SqliteTaskRepository({ db: dbA });
    const b = new SqliteTaskRepository({ db: dbB });
    await a.save(sample);
    expect(await a.read(ID)).toEqual(sample);
    expect(await b.read(ID)).toBeNull();
    dbA.close();
    dbB.close();
  });
});

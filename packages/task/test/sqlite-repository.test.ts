import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTaskIdError, SqliteTaskRepository, Task, type TaskStatus } from "../src/index.js";

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
function makeTask(overrides: {
  id?: string;
  agent?: string;
  instructions?: string;
  status?: TaskStatus;
  metadata?: Readonly<Record<string, unknown>>;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  result?: { output: string };
  failure?: { error: string };
} = {}): Task {
  return Task.fromStored({
    id: overrides.id ?? ID,
    agent: overrides.agent ?? "writer",
    instructions: overrides.instructions ?? "do the thing",
    status: overrides.status ?? "running",
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? CREATED_AT,
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.endedAt !== undefined ? { endedAt: overrides.endedAt } : {}),
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    ...(overrides.failure !== undefined ? { failure: overrides.failure } : {}),
  });
}

describe("SqliteTaskRepository", () => {
  it("save + read round-trip preserves all base fields", async () => {
    const sample = makeTask();
    await repo.save(sample);
    const back = await repo.read(ID);
    expect(back?.toJSON()).toEqual(sample.toJSON());
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

  it("save preserves optional terminal fields (result.output, failure.error, started/ended)", async () => {
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
      failure: { error: "boom" },
    });
    await repo.save(failure);
    expect((await repo.read(ID))?.toJSON()).toEqual(failure.toJSON());
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
    await repo.save(makeTask({ id: "20260101-cccccccc", status: "failure" }));
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
    const sample = makeTask();
    await a.save(sample);
    expect((await a.read(ID))?.toJSON()).toEqual(sample.toJSON());
    expect(await b.read(ID)).toBeNull();
    dbA.close();
    dbB.close();
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorruptedTaskError, FsTaskRepository, type Task } from "../src/index.js";

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await mkdtemp(path.join(tmpdir(), "emploke-fs-task-"));
});
afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true });
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

const writeWire = async (id: string, value: object) => {
  const dir = path.join(tasksDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "task.json"), JSON.stringify(value), "utf8");
};

describe("FsTaskRepository", () => {
  it("save + read round-trip with flat A1 wire shape", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    await mkdir(path.join(tasksDir, ID), { recursive: true });
    await repo.save(sample);
    const back = await repo.read(ID);
    expect(back).toEqual(sample);
    const raw = JSON.parse(await readFile(path.join(tasksDir, ID, "task.json"), "utf8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.id).toBe(ID);
    expect(raw.task).toBeUndefined();
  });

  it("read returns null for missing task.json", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    expect(await repo.read("20260509-deadbeef")).toBeNull();
  });

  it("read throws CorruptedTaskError on malformed JSON", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    const dir = path.join(tasksDir, ID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "task.json"), "not json", "utf8");
    await expect(repo.read(ID)).rejects.toBeInstanceOf(CorruptedTaskError);
  });

  it("read throws on newer schemaVersion (upgrade hint)", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    await writeWire(ID, { schemaVersion: 99, ...sample });
    await expect(repo.read(ID)).rejects.toMatchObject({
      constructor: CorruptedTaskError,
      reason: expect.stringContaining("Upgrade the server"),
    });
  });

  it("read throws on older schemaVersion (migration hint)", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    await writeWire(ID, { schemaVersion: 0, ...sample });
    await expect(repo.read(ID)).rejects.toMatchObject({
      constructor: CorruptedTaskError,
      reason: expect.stringContaining("Migration from older versions"),
    });
  });

  it("list filters by agent / status / createdSince / runtime", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    const a: Task = {
      ...sample,
      id: "20260101-aaaaaaaa",
      agent: "writer",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const b: Task = {
      ...sample,
      id: "20260601-bbbbbbbb",
      agent: "reviewer",
      status: "success",
      createdAt: "2026-06-01T00:00:00.000Z",
      metadata: { runtime: "gemini" },
    };
    await mkdir(path.join(tasksDir, a.id), { recursive: true });
    await mkdir(path.join(tasksDir, b.id), { recursive: true });
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

  it("list silently drops dirs whose task.json is corrupted", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    await mkdir(path.join(tasksDir, "20260101-aaaaaaaa"), { recursive: true });
    await repo.save({ ...sample, id: "20260101-aaaaaaaa" });
    await writeWire("20260101-bbbbbbbb", { schemaVersion: 99, ...sample, id: "20260101-bbbbbbbb" });
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("20260101-aaaaaaaa");
  });

  it("delete is idempotent for missing task", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    await repo.delete("20260101-cccccccc");
  });

  it("list() silently drops id-mismatched tasks (parseTask throws, list catches)", async () => {
    // Companion to the read() id-mismatch test above. list() catches
    // CorruptedTaskError per-entry; a single bad task.json must not
    // remove healthy tasks from the result.
    const repo = new FsTaskRepository({ tasksDir });
    const goodId = "20260101-aaaaaaaa";
    await repo.save({ ...sample, id: goodId });
    // Bad: dir name "20260101-bbbbbbbb" but payload claims a different id.
    await writeWire("20260101-bbbbbbbb", {
      schemaVersion: 1,
      ...sample,
      id: "20260101-cccccccc",
    });
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(goodId);
  });

  it("read throws CorruptedTaskError when task.id mismatches the dir name", async () => {
    // Catches the storage-key-vs-logical-id drift bug. A task.json
    // claiming id 'BBB' inside <tasksDir>/AAA/ would otherwise be
    // returned as a Task with id BBB; subsequent read/save/delete
    // keyed off BBB would target the (non-existent) BBB/ dir.
    const repo = new FsTaskRepository({ tasksDir });
    await writeWire(ID, {
      schemaVersion: 1,
      ...sample,
      id: "20260509-deadbeef", // != ID
    });
    await expect(repo.read(ID)).rejects.toMatchObject({
      constructor: CorruptedTaskError,
      reason: expect.stringContaining("task.id mismatch"),
    });
  });

  it("read throws CorruptedTaskError on out-of-range status enum value", async () => {
    const repo = new FsTaskRepository({ tasksDir });
    await writeWire(ID, { schemaVersion: 1, ...sample, status: "weird" });
    await expect(repo.read(ID)).rejects.toMatchObject({
      constructor: CorruptedTaskError,
      reason: expect.stringContaining("task.status must be one of"),
    });
  });

  it("save creates the task dir if it was deleted between dispatch and applyTerminal", async () => {
    // Belt-and-braces: TaskManager.dispatch mkdirs upfront, but the
    // dir may have been removed in the interim. save() must mkdirP
    // the parent so the write doesn't fail silently.
    const repo = new FsTaskRepository({ tasksDir });
    await repo.save(sample);
    expect(await repo.read(ID)).toEqual(sample);
  });
});

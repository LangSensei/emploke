import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, readPersistedTask, TASK_FILE_NAME } from "../src/index.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "emploke-task-file-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const sampleTask = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  task: {
    id: "20260508-aabbccdd",
    agent: "writer",
    instructions: "do",
    status: "running",
    metadata: {},
    createdAt: "2026-05-08T01:00:00.000Z",
  },
};

const writeTaskJson = async (override: Record<string, unknown>) => {
  const taskDir = path.join(workdir, "task-x");
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, TASK_FILE_NAME),
    JSON.stringify({ ...sampleTask, ...override }),
    "utf8",
  );
  return taskDir;
};

describe("readPersistedTask — schemaVersion mismatch", () => {
  it("returns null when the file is missing (this is not a task dir)", async () => {
    const taskDir = path.join(workdir, "missing");
    await mkdir(taskDir, { recursive: true });
    const r = await readPersistedTask(taskDir);
    expect(r).toBeNull();
  });

  it("rejects newer schemaVersion with an upgrade-server hint", async () => {
    const dir = await writeTaskJson({ schemaVersion: 99 });
    const r = await readPersistedTask(dir);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Upgrade the server"),
    });
  });

  it("rejects older schemaVersion with a migration-not-implemented hint", async () => {
    const dir = await writeTaskJson({ schemaVersion: 0 });
    const r = await readPersistedTask(dir);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Migration from older versions"),
    });
  });

  it("rejects non-numeric schemaVersion as generic unsupported", async () => {
    const dir = await writeTaskJson({ schemaVersion: "v1" });
    const r = await readPersistedTask(dir);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("schemaVersion") });
  });

  it("accepts current schemaVersion", async () => {
    const dir = await writeTaskJson({});
    const r = await readPersistedTask(dir);
    expect(r).toMatchObject({ ok: true });
  });
});

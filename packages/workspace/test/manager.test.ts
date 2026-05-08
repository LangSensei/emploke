import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_FILE } from "../src/constants.js";
import {
  WorkspaceAlreadyExistsError,
  WorkspaceCorruptedError,
  WorkspaceNameInvalidError,
  WorkspaceNotFoundError,
  WorkspaceSchemaMismatchError,
} from "../src/errors.js";
import { WorkspaceManager } from "../src/manager.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-mgr-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

describe("WorkspaceManager.init", () => {
  it("creates workspace.json with name from basename when no name given", async () => {
    const dir = path.join(scratch, "my-project");
    const ws = await WorkspaceManager.init(dir);
    expect(ws.metadata.name).toBe("my-project");
    expect(ws.metadata.schemaVersion).toBe(1);
    expect(typeof ws.metadata.createdAt).toBe("string");
    const onDisk = JSON.parse(await readFile(path.join(dir, WORKSPACE_FILE), "utf8"));
    expect(onDisk.name).toBe("my-project");
  });

  it("creates the four standard subdirs", async () => {
    const dir = path.join(scratch, "p");
    const ws = await WorkspaceManager.init(dir);
    expect(await exists(ws.sessionsDir)).toBe(true);
    expect(await exists(ws.tasksDir)).toBe(true);
    expect(await exists(ws.workflowsDir)).toBe(true);
    expect(await exists(ws.logsDir)).toBe(true);
  });

  it("uses an explicit name when provided", async () => {
    const dir = path.join(scratch, "anything");
    const ws = await WorkspaceManager.init(dir, { name: "explicit-name" });
    expect(ws.metadata.name).toBe("explicit-name");
  });

  it("rejects an invalid name", async () => {
    await expect(
      WorkspaceManager.init(path.join(scratch, "x"), { name: "Bad Name" }),
    ).rejects.toBeInstanceOf(WorkspaceNameInvalidError);
  });

  it("rejects an invalid name derived from basename", async () => {
    await expect(WorkspaceManager.init(path.join(scratch, "Bad Name"))).rejects.toBeInstanceOf(
      WorkspaceNameInvalidError,
    );
  });

  it("persists defaults when given", async () => {
    const dir = path.join(scratch, "p");
    const ws = await WorkspaceManager.init(dir, {
      defaults: { runtime: "copilot", agent: "demo" },
    });
    expect(ws.metadata.defaults).toEqual({ runtime: "copilot", agent: "demo" });
  });

  it("throws WorkspaceAlreadyExistsError if workspace.json exists", async () => {
    const dir = path.join(scratch, "p");
    await WorkspaceManager.init(dir);
    await expect(WorkspaceManager.init(dir)).rejects.toBeInstanceOf(WorkspaceAlreadyExistsError);
  });

  it("uses the now() seam", async () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const ws = await WorkspaceManager.init(path.join(scratch, "p"), { now: () => fixed });
    expect(ws.metadata.createdAt).toBe(fixed.toISOString());
  });
});

describe("WorkspaceManager.open", () => {
  it("returns the parsed workspace", async () => {
    const dir = path.join(scratch, "p");
    const initted = await WorkspaceManager.init(dir, { name: "p" });
    const opened = await WorkspaceManager.open(dir);
    expect(opened.metadata).toEqual(initted.metadata);
    expect(opened.dir).toBe(initted.dir);
  });

  it("throws WorkspaceNotFoundError when workspace.json missing", async () => {
    const dir = path.join(scratch, "empty");
    await import("node:fs/promises").then((m) => m.mkdir(dir));
    await expect(WorkspaceManager.open(dir)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("throws WorkspaceCorruptedError on invalid JSON", async () => {
    const dir = path.join(scratch, "p");
    await import("node:fs/promises").then((m) => m.mkdir(dir));
    await writeFile(path.join(dir, WORKSPACE_FILE), "not json", "utf8");
    await expect(WorkspaceManager.open(dir)).rejects.toBeInstanceOf(WorkspaceCorruptedError);
  });

  it("throws WorkspaceCorruptedError when not an object", async () => {
    const dir = path.join(scratch, "p");
    await import("node:fs/promises").then((m) => m.mkdir(dir));
    await writeFile(path.join(dir, WORKSPACE_FILE), "[]", "utf8");
    await expect(WorkspaceManager.open(dir)).rejects.toBeInstanceOf(WorkspaceCorruptedError);
  });

  it("throws WorkspaceCorruptedError on missing required fields", async () => {
    const dir = path.join(scratch, "p");
    await import("node:fs/promises").then((m) => m.mkdir(dir));
    await writeFile(path.join(dir, WORKSPACE_FILE), JSON.stringify({ schemaVersion: 1 }), "utf8");
    await expect(WorkspaceManager.open(dir)).rejects.toBeInstanceOf(WorkspaceCorruptedError);
  });

  it("throws WorkspaceSchemaMismatchError on wrong schemaVersion", async () => {
    const dir = path.join(scratch, "p");
    await import("node:fs/promises").then((m) => m.mkdir(dir));
    await writeFile(
      path.join(dir, WORKSPACE_FILE),
      JSON.stringify({ schemaVersion: 99, name: "p", createdAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    await expect(WorkspaceManager.open(dir)).rejects.toBeInstanceOf(WorkspaceSchemaMismatchError);
  });
});

describe("WorkspaceManager.openOrInit", () => {
  it("inits when missing", async () => {
    const dir = path.join(scratch, "fresh");
    const ws = await WorkspaceManager.openOrInit(dir);
    expect(ws.metadata.name).toBe("fresh");
  });

  it("opens when present", async () => {
    const dir = path.join(scratch, "exists");
    await WorkspaceManager.init(dir, { name: "exists" });
    const ws = await WorkspaceManager.openOrInit(dir, { name: "ignored" });
    // Open won't apply opts.name; it returns the persisted name.
    expect(ws.metadata.name).toBe("exists");
  });

  it("survives concurrent openOrInit on the same dir", async () => {
    const dir = path.join(scratch, "race");
    const results = await Promise.all([
      WorkspaceManager.openOrInit(dir),
      WorkspaceManager.openOrInit(dir),
      WorkspaceManager.openOrInit(dir),
    ]);
    for (const r of results) expect(r.metadata.name).toBe("race");
  });
});

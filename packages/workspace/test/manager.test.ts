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
  it("creates workspace.json with the supplied display name", async () => {
    const dir = path.join(scratch, "any-folder");
    const ws = await WorkspaceManager.init(dir, { name: "My Workspace" });
    expect(ws.metadata.name).toBe("My Workspace");
    expect(ws.metadata.schemaVersion).toBe(1);
    expect(typeof ws.metadata.createdAt).toBe("string");
    const onDisk = JSON.parse(await readFile(path.join(dir, WORKSPACE_FILE), "utf8"));
    expect(onDisk.name).toBe("My Workspace");
  });

  it("creates the standard subdirs", async () => {
    const dir = path.join(scratch, "p");
    const ws = await WorkspaceManager.init(dir, { name: "p" });
    expect(await exists(ws.sessionsDir)).toBe(true);
    expect(await exists(ws.catalogDir)).toBe(true);
    expect(await exists(ws.tasksDir)).toBe(true);
    expect(await exists(ws.workflowsDir)).toBe(true);
    expect(await exists(ws.logsDir)).toBe(true);
  });

  it("accepts unicode display names", async () => {
    const dir = path.join(scratch, "anything");
    const ws = await WorkspaceManager.init(dir, { name: "工作区 " });
    expect(ws.metadata.name).toBe("工作区 ");
  });

  it("requires a display name (no basename fallback)", async () => {
    await expect(
      WorkspaceManager.init(path.join(scratch, "x"), {} as { name?: string }),
    ).rejects.toBeInstanceOf(WorkspaceNameInvalidError);
  });

  it("rejects an empty / whitespace-only name", async () => {
    await expect(
      WorkspaceManager.init(path.join(scratch, "x"), { name: "   " }),
    ).rejects.toBeInstanceOf(WorkspaceNameInvalidError);
  });

  it("persists defaults when given", async () => {
    const dir = path.join(scratch, "p");
    const ws = await WorkspaceManager.init(dir, {
      name: "p",
      defaults: { runtime: "copilot", agent: "demo" },
    });
    expect(ws.metadata.defaults).toEqual({ runtime: "copilot", agent: "demo" });
  });

  it("throws WorkspaceAlreadyExistsError if workspace.json exists", async () => {
    const dir = path.join(scratch, "p");
    await WorkspaceManager.init(dir, { name: "p" });
    await expect(WorkspaceManager.init(dir, { name: "p" })).rejects.toBeInstanceOf(
      WorkspaceAlreadyExistsError,
    );
  });

  it("uses the now() seam", async () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const ws = await WorkspaceManager.init(path.join(scratch, "p"), {
      name: "p",
      now: () => fixed,
    });
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
    const ws = await WorkspaceManager.openOrInit(dir, { name: "Fresh One" });
    expect(ws.metadata.name).toBe("Fresh One");
  });

  it("opens when present (ignoring opts.name)", async () => {
    const dir = path.join(scratch, "exists");
    await WorkspaceManager.init(dir, { name: "Original" });
    const ws = await WorkspaceManager.openOrInit(dir, { name: "Ignored" });
    expect(ws.metadata.name).toBe("Original");
  });

  it("survives concurrent openOrInit on the same dir", async () => {
    const dir = path.join(scratch, "race");
    const results = await Promise.all([
      WorkspaceManager.openOrInit(dir, { name: "Race" }),
      WorkspaceManager.openOrInit(dir, { name: "Race" }),
      WorkspaceManager.openOrInit(dir, { name: "Race" }),
    ]);
    for (const r of results) expect(r.metadata.name).toBe("Race");
  });
});

describe("WorkspaceManager.update", () => {
  it("renames the workspace and rewrites workspace.json atomically", async () => {
    const dir = path.join(scratch, "ws-dir");
    await WorkspaceManager.init(dir, { name: "Old Name" });
    const updated = await WorkspaceManager.update(dir, { name: "New Name" });
    expect(updated.metadata.name).toBe("New Name");
    const onDisk = JSON.parse(await readFile(path.join(dir, WORKSPACE_FILE), "utf8"));
    expect(onDisk.name).toBe("New Name");
    expect(onDisk.schemaVersion).toBe(1);
    // createdAt must be preserved across updates.
    expect(onDisk.createdAt).toBe(updated.metadata.createdAt);
  });

  it("preserves defaults when patch.defaults is undefined", async () => {
    const dir = path.join(scratch, "with-defaults");
    await WorkspaceManager.init(dir, {
      name: "With Defaults",
      defaults: { runtime: "copilot", agent: "claude" },
    });
    const updated = await WorkspaceManager.update(dir, { name: "Renamed" });
    expect(updated.metadata.defaults).toEqual({ runtime: "copilot", agent: "claude" });
  });

  it("clears defaults when patch.defaults is null", async () => {
    const dir = path.join(scratch, "clear-defaults");
    await WorkspaceManager.init(dir, {
      name: "Clear",
      defaults: { runtime: "copilot" },
    });
    const updated = await WorkspaceManager.update(dir, { defaults: null });
    expect(updated.metadata.defaults).toBeUndefined();
  });

  it("rejects an empty name", async () => {
    const dir = path.join(scratch, "valid");
    await WorkspaceManager.init(dir, { name: "Valid" });
    await expect(WorkspaceManager.update(dir, { name: "" })).rejects.toBeInstanceOf(
      WorkspaceNameInvalidError,
    );
    // workspace.json must not be touched on validation failure.
    const onDisk = JSON.parse(await readFile(path.join(dir, WORKSPACE_FILE), "utf8"));
    expect(onDisk.name).toBe("Valid");
  });

  it("throws WorkspaceNotFoundError if workspace.json is missing", async () => {
    const dir = path.join(scratch, "ghost");
    await expect(WorkspaceManager.update(dir, { name: "Anything" })).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });
});

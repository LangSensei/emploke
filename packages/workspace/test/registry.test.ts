import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegistryCorruptedError,
  WorkspaceNameConflictError,
  WorkspaceNameInvalidError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../src/errors.js";
import { WorkspaceRegistry } from "../src/registry.js";

let scratch: string;
let registryFile: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-reg-"));
  registryFile = path.join(scratch, "workspaces.json");
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("WorkspaceRegistry.open", () => {
  it("creates an empty registry when file is missing", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    expect(r.list()).toEqual([]);
    expect(r.current()).toBeNull();
  });

  it("loads an existing registry", async () => {
    await writeFile(
      registryFile,
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ name: "a", path: "/abs/a" }],
        currentName: "a",
      }),
      "utf8",
    );
    const r = await WorkspaceRegistry.open(registryFile);
    expect(r.list()).toEqual([{ name: "a", path: "/abs/a" }]);
    expect(r.current()).toBe("a");
  });

  it("rejects malformed registry json", async () => {
    await writeFile(registryFile, "not json", "utf8");
    await expect(WorkspaceRegistry.open(registryFile)).rejects.toBeInstanceOf(
      RegistryCorruptedError,
    );
  });

  it("rejects wrong schemaVersion", async () => {
    await writeFile(registryFile, JSON.stringify({ schemaVersion: 99, entries: [] }), "utf8");
    await expect(WorkspaceRegistry.open(registryFile)).rejects.toBeInstanceOf(
      RegistryCorruptedError,
    );
  });

  it("rejects an entry without a name", async () => {
    await writeFile(
      registryFile,
      JSON.stringify({ schemaVersion: 1, entries: [{ path: "/x" }] }),
      "utf8",
    );
    await expect(WorkspaceRegistry.open(registryFile)).rejects.toBeInstanceOf(
      RegistryCorruptedError,
    );
  });
});

describe("WorkspaceRegistry.add", () => {
  it("appends a new entry", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "alpha", path: path.join(scratch, "alpha") });
    expect(r.list()).toHaveLength(1);
    expect(r.has("alpha")).toBe(true);
  });

  it("persists the entry to disk", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "alpha", path: path.join(scratch, "alpha") });
    const onDisk = JSON.parse(await readFile(registryFile, "utf8"));
    expect(onDisk.entries[0].name).toBe("alpha");
  });

  it("resolves the path to absolute", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "rel", path: "relative/path" });
    expect(r.get("rel")?.path).toBe(path.resolve("relative/path"));
  });

  it("rejects an invalid name", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await expect(r.add({ name: "Bad", path: "/x" })).rejects.toBeInstanceOf(
      WorkspaceNameInvalidError,
    );
  });

  it("rejects duplicate name", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "dup", path: "/x" });
    await expect(r.add({ name: "dup", path: "/y" })).rejects.toBeInstanceOf(
      WorkspaceNameConflictError,
    );
  });

  it("rejects duplicate path under different name", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "first", path: "/shared" });
    await expect(r.add({ name: "second", path: "/shared" })).rejects.toBeInstanceOf(
      WorkspacePathConflictError,
    );
  });

  it("serialises concurrent adds without losing entries", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await Promise.all([
      r.add({ name: "a", path: "/a" }),
      r.add({ name: "b", path: "/b" }),
      r.add({ name: "c", path: "/c" }),
      r.add({ name: "d", path: "/d" }),
    ]);
    const names = r
      .list()
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(["a", "b", "c", "d"]);
    const onDisk = JSON.parse(await readFile(registryFile, "utf8"));
    expect(onDisk.entries).toHaveLength(4);
  });
});

describe("WorkspaceRegistry.remove", () => {
  it("drops the entry", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "a", path: "/a" });
    await r.remove("a");
    expect(r.has("a")).toBe(false);
  });

  it("clears currentName if it pointed to the removed entry", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "a", path: "/a" });
    await r.setCurrent("a");
    await r.remove("a");
    expect(r.current()).toBeNull();
  });

  it("leaves currentName alone if it pointed elsewhere", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "a", path: "/a" });
    await r.add({ name: "b", path: "/b" });
    await r.setCurrent("b");
    await r.remove("a");
    expect(r.current()).toBe("b");
  });

  it("throws when removing a name not present", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await expect(r.remove("ghost")).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });
});

describe("WorkspaceRegistry.setCurrent", () => {
  it("sets currentName and bumps lastOpenedAt", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ name: "a", path: "/a" });
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    await r.setCurrent("a", () => fixed);
    expect(r.current()).toBe("a");
    expect(r.get("a")?.lastOpenedAt).toBe(fixed.toISOString());
  });

  it("throws on unknown name", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await expect(r.setCurrent("ghost")).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });
});

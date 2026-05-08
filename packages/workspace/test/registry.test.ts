import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegistryCorruptedError,
  WorkspaceIdConflictError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../src/errors.js";
import { isValidWorkspaceId } from "../src/names.js";
import { WorkspaceRegistry } from "../src/registry.js";

let scratch: string;
let registryFile: string;

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

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

  it("loads an existing registry by id", async () => {
    await writeFile(
      registryFile,
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ id: UUID_A, path: "/abs/a" }],
        currentId: UUID_A,
      }),
      "utf8",
    );
    const r = await WorkspaceRegistry.open(registryFile);
    expect(r.list()).toEqual([{ id: UUID_A, path: "/abs/a" }]);
    expect(r.current()).toBe(UUID_A);
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

  it("rejects an entry without id and without legacy name", async () => {
    await writeFile(
      registryFile,
      JSON.stringify({ schemaVersion: 1, entries: [{ path: "/x" }] }),
      "utf8",
    );
    await expect(WorkspaceRegistry.open(registryFile)).rejects.toBeInstanceOf(
      RegistryCorruptedError,
    );
  });

  it("rejects an entry whose id is not a uuid", async () => {
    await writeFile(
      registryFile,
      JSON.stringify({ schemaVersion: 1, entries: [{ id: "not-a-uuid", path: "/x" }] }),
      "utf8",
    );
    await expect(WorkspaceRegistry.open(registryFile)).rejects.toBeInstanceOf(
      RegistryCorruptedError,
    );
  });

  it("migrates legacy {name, path} entries by assigning fresh UUIDs and rewriting the file", async () => {
    await writeFile(
      registryFile,
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          { name: "alpha", path: "/abs/alpha" },
          { name: "beta", path: "/abs/beta", lastOpenedAt: "2025-01-01T00:00:00.000Z" },
        ],
        currentName: "beta",
      }),
      "utf8",
    );
    const r = await WorkspaceRegistry.open(registryFile);
    const list = r.list();
    expect(list).toHaveLength(2);
    expect(list.every((e) => isValidWorkspaceId(e.id))).toBe(true);
    expect(list.map((e) => e.path)).toEqual(["/abs/alpha", "/abs/beta"]);
    // Find which uuid replaces "beta" and confirm it became currentId.
    const beta = list[1];
    expect(beta).toBeDefined();
    expect(beta?.lastOpenedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(r.current()).toBe(beta?.id);

    // Migration is persisted: re-reading without re-running migration must
    // see the same id.
    const persisted = JSON.parse(await readFile(registryFile, "utf8"));
    expect(persisted.entries[0].name).toBeUndefined();
    expect(persisted.entries[0].id).toBe(list[0]?.id);
    expect(persisted.currentName).toBeUndefined();
    expect(persisted.currentId).toBe(beta?.id);
  });
});

describe("WorkspaceRegistry.add", () => {
  it("appends a new entry with a generated UUID", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const entry = await r.add({ path: path.join(scratch, "alpha") });
    expect(isValidWorkspaceId(entry.id)).toBe(true);
    expect(r.list()).toHaveLength(1);
    expect(r.has(entry.id)).toBe(true);
  });

  it("persists the entry to disk", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const entry = await r.add({ path: path.join(scratch, "alpha") });
    const onDisk = JSON.parse(await readFile(registryFile, "utf8"));
    expect(onDisk.entries[0].id).toBe(entry.id);
    expect(onDisk.entries[0].name).toBeUndefined();
  });

  it("resolves the path to absolute", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const entry = await r.add({ path: "relative/path" });
    expect(r.get(entry.id)?.path).toBe(path.resolve("relative/path"));
  });

  it("accepts an explicit valid id", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const entry = await r.add({ id: UUID_A, path: "/x" });
    expect(entry.id).toBe(UUID_A);
  });

  it("rejects an explicit non-uuid id", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await expect(r.add({ id: "not-a-uuid", path: "/x" })).rejects.toBeInstanceOf(
      WorkspaceIdConflictError,
    );
  });

  it("rejects duplicate id", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ id: UUID_A, path: "/x" });
    await expect(r.add({ id: UUID_A, path: "/y" })).rejects.toBeInstanceOf(
      WorkspaceIdConflictError,
    );
  });

  it("rejects duplicate path under different id", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await r.add({ id: UUID_A, path: "/shared" });
    await expect(r.add({ id: UUID_B, path: "/shared" })).rejects.toBeInstanceOf(
      WorkspacePathConflictError,
    );
  });

  it("serialises concurrent adds without losing entries", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const paths = ["a", "b", "c", "d"].map((n) => path.join(scratch, n));
    await Promise.all(paths.map((p) => r.add({ path: p })));
    const stored = r
      .list()
      .map((e) => e.path)
      .sort();
    expect(stored).toEqual([...paths].sort());
    const onDisk = JSON.parse(await readFile(registryFile, "utf8"));
    expect(onDisk.entries).toHaveLength(4);
  });
});

describe("WorkspaceRegistry.remove", () => {
  it("drops the entry", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const entry = await r.add({ path: "/a" });
    await r.remove(entry.id);
    expect(r.has(entry.id)).toBe(false);
  });

  it("clears currentId if it pointed to the removed entry", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const entry = await r.add({ path: "/a" });
    await r.setCurrent(entry.id);
    await r.remove(entry.id);
    expect(r.current()).toBeNull();
  });

  it("leaves currentId alone if it pointed elsewhere", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const a = await r.add({ path: "/a" });
    const b = await r.add({ path: "/b" });
    await r.setCurrent(b.id);
    await r.remove(a.id);
    expect(r.current()).toBe(b.id);
  });

  it("throws when removing an id not present", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await expect(r.remove(UUID_A)).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });
});

describe("WorkspaceRegistry.setCurrent", () => {
  it("sets currentId and bumps lastOpenedAt", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    const entry = await r.add({ path: "/a" });
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    await r.setCurrent(entry.id, () => fixed);
    expect(r.current()).toBe(entry.id);
    expect(r.get(entry.id)?.lastOpenedAt).toBe(fixed.toISOString());
  });

  it("throws on unknown id", async () => {
    const r = await WorkspaceRegistry.open(registryFile);
    await expect(r.setCurrent(UUID_A)).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });
});

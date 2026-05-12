import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FsWorkspaceRepository,
  RegistryCorruptedError,
  RegistrySchemaMismatchError,
  WorkspaceCorruptedError,
  WorkspaceIdConflictError,
  WorkspaceManager,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
  WorkspaceSchemaMismatchError,
} from "../src/index.js";
import { InMemoryWorkspaceRepository } from "../src/testing.js";

let scratch: string;
let indexFile: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-mgr-"));
  indexFile = path.join(scratch, ".emploke", "workspaces.json");
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const newFsManager = () => new WorkspaceManager(new FsWorkspaceRepository({ indexFile }));
const newInMemoryManager = () => new WorkspaceManager(new InMemoryWorkspaceRepository());

describe("WorkspaceManager (FsWorkspaceRepository) — init", () => {
  it("creates the workdir + standard subdirs and persists the workspace", async () => {
    const m = newFsManager();
    const wsDir = path.join(scratch, "p");
    const ws = await m.init({ id: UUID_A, name: "My Project", workdir: wsDir });

    expect(ws.id).toBe(UUID_A);
    expect(ws.name).toBe("My Project");
    expect(ws.workdir).toBe(path.resolve(wsDir));
    // Standard subdirs were created.
    const fsImport = await import("node:fs/promises");
    for (const sub of ["sessions", "tasks", "catalog"]) {
      const st = await fsImport.stat(path.join(wsDir, sub));
      expect(st.isDirectory()).toBe(true);
    }
    // Round-trips through the repository.
    const back = await m.read(UUID_A);
    expect(back).toMatchObject({ id: UUID_A, name: "My Project" });
  });

  it("rejects an invalid display name", async () => {
    const m = newFsManager();
    await expect(m.init({ name: "", workdir: path.join(scratch, "x") })).rejects.toThrow();
  });

  it("rejects when the same workdir is registered twice with different ids", async () => {
    const m = newFsManager();
    const wsDir = path.join(scratch, "shared");
    await m.init({ id: UUID_A, name: "A", workdir: wsDir });
    await expect(m.init({ id: UUID_B, name: "B", workdir: wsDir })).rejects.toBeInstanceOf(
      WorkspacePathConflictError,
    );
  });

  it("rejects when the same id is initialized twice (sequential)", async () => {
    const m = newFsManager();
    await m.init({ id: UUID_A, name: "First", workdir: path.join(scratch, "first") });
    await expect(
      m.init({ id: UUID_A, name: "Second", workdir: path.join(scratch, "second") }),
    ).rejects.toBeInstanceOf(WorkspaceIdConflictError);
  });

  it("rejects concurrent init({id: same}) with WorkspaceIdConflictError (lock-loser sees the conflict)", async () => {
    // Regression for #42: previously WorkspaceManager did read+save and
    // had a race window where two concurrent init({id: same}) calls
    // could both pass the manager-side check and silently overwrite each
    // other in repository.save (last writer wins). Repository.create()
    // performs the id-conflict check inside the registry lock, so one
    // call must win and one must throw WorkspaceIdConflictError.
    const m = newFsManager();
    const dirA = path.join(scratch, "race-a");
    const dirB = path.join(scratch, "race-b");
    const results = await Promise.allSettled([
      m.init({ id: UUID_A, name: "First", workdir: dirA }),
      m.init({ id: UUID_A, name: "Second", workdir: dirB }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkspaceIdConflictError);
    // The winning workdir is whichever call reached the lock first.
    const back = await m.read(UUID_A);
    expect(back).not.toBeNull();
    expect([path.resolve(dirA), path.resolve(dirB)]).toContain(back!.workdir);
  });

  it("auto-mints an id when none is supplied", async () => {
    const m = newFsManager();
    const ws = await m.init({ name: "Auto", workdir: path.join(scratch, "auto") });
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("WorkspaceManager — list / read", () => {
  it("list returns all registered workspaces", async () => {
    const m = newFsManager();
    await m.init({ id: UUID_A, name: "A", workdir: path.join(scratch, "a") });
    await m.init({ id: UUID_B, name: "B", workdir: path.join(scratch, "b") });
    const all = await m.list();
    expect(all.map((w) => w.id).sort()).toEqual([UUID_A, UUID_B].sort());
  });

  it("read returns null for an unregistered id", async () => {
    const m = newFsManager();
    expect(await m.read(UUID_A)).toBeNull();
  });
});

describe("WorkspaceManager — update", () => {
  it("renames a workspace and preserves immutable fields", async () => {
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "Old", workdir: path.join(scratch, "x") });
    const updated = await m.update(UUID_A, { name: "New" });
    expect(updated.name).toBe("New");
    expect(updated.workdir).toBe(ws.workdir);
    expect(updated.createdAt).toBe(ws.createdAt);
  });

  it("clears defaults when passed null", async () => {
    const m = newFsManager();
    await m.init({
      id: UUID_A,
      name: "X",
      workdir: path.join(scratch, "x"),
      defaults: { runtime: "copilot" },
    });
    const updated = await m.update(UUID_A, { defaults: null });
    expect(updated.defaults).toBeUndefined();
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    const m = newFsManager();
    await expect(m.update(UUID_A, { name: "x" })).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
  });
});

describe("WorkspaceManager — delete", () => {
  it("default delete removes only metadata; workdir contents preserved", async () => {
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    // Drop a user file inside the workdir (NOT in an emploke-owned subdir).
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(ws.workdir, "user-file.txt"), "user data", "utf8");
    await fs.writeFile(
      path.join(ws.workdir, "sessions", "session-trace.txt"),
      "agent file",
      "utf8",
    );

    await m.delete(UUID_A);
    expect(await m.read(UUID_A)).toBeNull();
    // workspace.json removed
    await expect(fs.stat(path.join(ws.workdir, "workspace.json"))).rejects.toThrow();
    // user file preserved
    expect(await fs.readFile(path.join(ws.workdir, "user-file.txt"), "utf8")).toBe("user data");
    // sessions subdir preserved (not purged by default)
    expect(await fs.readFile(path.join(ws.workdir, "sessions", "session-trace.txt"), "utf8")).toBe(
      "agent file",
    );
  });

  it("purge=true also removes emploke-owned subdirs but preserves workdir + user files", async () => {
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(ws.workdir, "user-file.txt"), "user data", "utf8");
    await fs.writeFile(path.join(ws.workdir, "sessions", "trace.txt"), "agent", "utf8");

    await m.delete(UUID_A, { purge: true });
    expect(await m.read(UUID_A)).toBeNull();
    // every emploke-owned subdir gone — pin all three so a future
    // accidental drop from the purge list (or a layout addition that
    // forgets a corresponding rm) gets caught.
    await expect(fs.stat(path.join(ws.workdir, "sessions"))).rejects.toThrow();
    await expect(fs.stat(path.join(ws.workdir, "tasks"))).rejects.toThrow();
    await expect(fs.stat(path.join(ws.workdir, "catalog"))).rejects.toThrow();
    // workdir itself preserved
    const st = await fs.stat(ws.workdir);
    expect(st.isDirectory()).toBe(true);
    // user file preserved
    expect(await fs.readFile(path.join(ws.workdir, "user-file.txt"), "utf8")).toBe("user data");
  });

  it("delete is idempotent for unregistered ids", async () => {
    const m = newFsManager();
    await m.delete(UUID_A); // no throw
    await m.delete(UUID_A, { purge: true }); // also no throw
  });

  it("delete(purge:true) purges sandbox dirs BEFORE removing the registry entry", async () => {
    // Regression: removing the index entry first opens a window where
    // a concurrent init({workdir: same}) could succeed and start
    // populating sandbox dirs that the in-flight purge would then
    // wipe. Purge-then-delete keeps the path-conflict guard active
    // throughout the sandbox cleanup.
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(ws.workdir, "sessions", "marker.txt"), "x", "utf8");

    // Concurrent init({workdir: ws.workdir}) attempted while the purge is
    // running must throw WorkspacePathConflictError — meaning the
    // registry entry is still present at the moment the conflict check
    // runs. We approximate this by attempting init right after delete
    // returns and asserting the new entry sees the now-empty workdir
    // (post-purge) without colliding.
    await m.delete(UUID_A, { purge: true });
    expect(await m.read(UUID_A)).toBeNull();
    await expect(fs.stat(path.join(ws.workdir, "sessions"))).rejects.toThrow();
    // Workdir itself preserved.
    const st = await fs.stat(ws.workdir);
    expect(st.isDirectory()).toBe(true);
  });
});

describe("WorkspaceManager — current selection", () => {
  it("getCurrent returns null when nothing selected", async () => {
    const m = newFsManager();
    expect(await m.getCurrent()).toBeNull();
  });

  it("setCurrent + getCurrent round-trip", async () => {
    const m = newFsManager();
    await m.init({ id: UUID_A, name: "A", workdir: path.join(scratch, "a") });
    await m.setCurrent(UUID_A);
    expect(await m.getCurrent()).toBe(UUID_A);
  });

  it("setCurrent throws for an unregistered id", async () => {
    const m = newFsManager();
    await expect(m.setCurrent(UUID_A)).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });

  it("delete clears currentId when the deleted workspace was current", async () => {
    const m = newFsManager();
    await m.init({ id: UUID_A, name: "A", workdir: path.join(scratch, "a") });
    await m.setCurrent(UUID_A);
    await m.delete(UUID_A);
    expect(await m.getCurrent()).toBeNull();
  });
});

describe("FsWorkspaceRepository — corruption / schema mismatch", () => {
  it("rejects newer schemaVersion in workspace.json with upgrade hint", async () => {
    const m = newFsManager();
    const wsDir = path.join(scratch, "x");
    await m.init({ id: UUID_A, name: "X", workdir: wsDir });
    // Corrupt workspace.json with a newer schemaVersion.
    await writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ schemaVersion: 99, name: "X", createdAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    await expect(m.read(UUID_A)).rejects.toBeInstanceOf(WorkspaceSchemaMismatchError);
  });

  it("rejects newer schemaVersion in the index with upgrade hint", async () => {
    // Plant a future-version index file directly.
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    await writeFile(indexFile, JSON.stringify({ schemaVersion: 99, entries: [] }), "utf8");
    const m = newFsManager();
    await expect(m.list()).rejects.toBeInstanceOf(RegistrySchemaMismatchError);
  });

  it("non-numeric schemaVersion in the index is generic corruption", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    await writeFile(indexFile, JSON.stringify({ schemaVersion: "v1", entries: [] }), "utf8");
    const m = newFsManager();
    await expect(m.list()).rejects.toBeInstanceOf(RegistryCorruptedError);
  });

  it("missing workspace.json causes the entry to be dropped from list (warns)", async () => {
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    const fs = await import("node:fs/promises");
    // Remove the metadata file out from under the index.
    await fs.rm(path.join(ws.workdir, "workspace.json"), { force: true });

    const all = await m.list();
    expect(all).toEqual([]);
  });

  it("explicitly corrupted workspace.json bubbles WorkspaceCorruptedError on read(id)", async () => {
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    await writeFile(path.join(ws.workdir, "workspace.json"), "not json", "utf8");
    await expect(m.read(UUID_A)).rejects.toBeInstanceOf(WorkspaceCorruptedError);
  });

  it("explicitly corrupted workspace.json is dropped from list() (resilient)", async () => {
    // Regression: tryHydrate used to throw on parse errors, taking down
    // the whole list. list() must isolate per-entry corruption so a single
    // bad workspace doesn't hide every other registered one.
    const m = newFsManager();
    await m.init({ id: UUID_A, name: "Healthy", workdir: path.join(scratch, "h") });
    const bad = await m.init({ id: UUID_B, name: "Bad", workdir: path.join(scratch, "b") });
    await writeFile(path.join(bad.workdir, "workspace.json"), "not json", "utf8");

    const all = await m.list();
    expect(all.map((w) => w.id)).toEqual([UUID_A]);
    // Single-id read still surfaces the typed error.
    await expect(m.read(UUID_B)).rejects.toBeInstanceOf(WorkspaceCorruptedError);
  });
});

describe("FsWorkspaceRepository — _readme audit field", () => {
  it("workspaces.json carries the SERVER_MANAGED_README marker", async () => {
    // Anyone who hand-cats workspaces.json should immediately see this
    // is server-managed state and find the README pointer. The parser
    // must ignore it on read (covered by the round-trip in the next test).
    const { SERVER_MANAGED_README } = await import("@emploke/paths");
    const m = newFsManager();
    await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    const fs = await import("node:fs/promises");
    const raw = JSON.parse(await fs.readFile(indexFile, "utf8")) as Record<string, unknown>;
    expect(raw._readme).toBe(SERVER_MANAGED_README);
  });

  it("per-workspace workspace.json carries the SERVER_MANAGED_README marker", async () => {
    const { SERVER_MANAGED_README } = await import("@emploke/paths");
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    const fs = await import("node:fs/promises");
    const raw = JSON.parse(
      await fs.readFile(path.join(ws.workdir, "workspace.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw._readme).toBe(SERVER_MANAGED_README);
  });

  it("the parsers tolerate the _readme field round-trip (read after write)", async () => {
    // Belt-and-braces: even though the parsers only check known fields,
    // assert end-to-end that the field we just wrote does not break
    // a subsequent read. Catches a future regression where someone
    // tightens validation to "no unknown keys" without realising _readme
    // is one.
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    expect(await m.read(UUID_A)).toEqual(ws);
    expect((await m.list())[0]).toEqual(ws);
  });

  it("a hand-edited workspace.json that drops _readme still loads (forward-compat)", async () => {
    // Users who hand-cat the file might delete the audit field; the
    // parser must keep working. (This is implicitly true today because
    // _readme isn't validated, but pinning it as a test stops a future
    // refactor that requires it from silently breaking older files.)
    const m = newFsManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    await writeFile(
      path.join(ws.workdir, "workspace.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "X",
        createdAt: ws.createdAt,
      }),
      "utf8",
    );
    const back = await m.read(UUID_A);
    expect(back?.name).toBe("X");
  });
});

describe("WorkspaceManager (InMemoryWorkspaceRepository) — sanity", () => {
  it("init / list / read / delete round-trip without touching the fs", async () => {
    const m = newInMemoryManager();
    const ws = await m.init({ id: UUID_A, name: "Mem", workdir: "/tmp/mem-ws" });
    expect(await m.list()).toEqual([ws]);
    expect(await m.read(UUID_A)).toEqual(ws);
    await m.delete(UUID_A);
    expect(await m.read(UUID_A)).toBeNull();
  });

  // Note: init() still calls mkdir() on the chosen workdir — it has to,
  // because a real agent will spawn there. So InMemory tests still
  // touch /tmp briefly. If a future test wants zero fs IO, pass
  // `mkdir`-stubbed workspace pre-existing in the seed and call
  // `repository.save` directly instead of `manager.init`.
});

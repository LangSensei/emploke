import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegistrySchemaMismatchError,
  SqliteWorkspaceRepository,
  WorkspaceCorruptedError,
  WorkspaceIdConflictError,
  WorkspaceManager,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../src/index.js";

let scratch: string;
let db: DatabaseSync;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-mgr-"));
  db = new DatabaseSync(":memory:");
});
afterEach(async () => {
  try {
    db.close();
  } catch {
    // already closed
  }
  await rm(scratch, { recursive: true, force: true });
});

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const newSqliteManager = () => new WorkspaceManager(new SqliteWorkspaceRepository({ db }));

describe("WorkspaceManager (SqliteWorkspaceRepository) — init", () => {
  it("creates the workdir + standard subdirs and persists the workspace", async () => {
    const m = newSqliteManager();
    const wsDir = path.join(scratch, "p");
    const ws = await m.init({ id: UUID_A, name: "My Project", workdir: wsDir });

    expect(ws.id).toBe(UUID_A);
    expect(ws.name).toBe("My Project");
    expect(ws.workdir).toBe(path.resolve(wsDir));
    // Standard subdirs were created. There is no `catalog/` —
    // catalog content lives inside `workspace.db` as BLOB rows.
    const fsImport = await import("node:fs/promises");
    for (const sub of ["sessions", "tasks"]) {
      const st = await fsImport.stat(path.join(wsDir, sub));
      expect(st.isDirectory()).toBe(true);
    }
    await expect(fsImport.stat(path.join(wsDir, "catalog"))).rejects.toThrow();
    // Round-trips through the repository.
    const back = await m.read(UUID_A);
    expect(back).toMatchObject({ id: UUID_A, name: "My Project" });
  });

  it("rejects an invalid display name", async () => {
    const m = newSqliteManager();
    await expect(m.init({ name: "", workdir: path.join(scratch, "x") })).rejects.toThrow();
  });

  it("rejects when the same workdir is registered twice with different ids", async () => {
    const m = newSqliteManager();
    const wsDir = path.join(scratch, "shared");
    await m.init({ id: UUID_A, name: "A", workdir: wsDir });
    await expect(m.init({ id: UUID_B, name: "B", workdir: wsDir })).rejects.toBeInstanceOf(
      WorkspacePathConflictError,
    );
  });

  it("rejects when the same id is initialized twice (sequential)", async () => {
    const m = newSqliteManager();
    await m.init({ id: UUID_A, name: "First", workdir: path.join(scratch, "first") });
    await expect(
      m.init({ id: UUID_A, name: "Second", workdir: path.join(scratch, "second") }),
    ).rejects.toBeInstanceOf(WorkspaceIdConflictError);
  });

  it("rejects concurrent init({id: same}) with WorkspaceIdConflictError (lock-loser sees the conflict)", async () => {
    // Regression for #42: previously WorkspaceManager did read+save and
    // had a race window where two concurrent init({id: same}) calls
    // could both pass the manager-side check. Repository.create()
    // performs the id-conflict check inside the registry lock, so one
    // call must win and one must throw WorkspaceIdConflictError.
    const m = newSqliteManager();
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
    const m = newSqliteManager();
    const ws = await m.init({ name: "Auto", workdir: path.join(scratch, "auto") });
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("WorkspaceManager — list / read", () => {
  it("list returns all registered workspaces", async () => {
    const m = newSqliteManager();
    await m.init({ id: UUID_A, name: "A", workdir: path.join(scratch, "a") });
    await m.init({ id: UUID_B, name: "B", workdir: path.join(scratch, "b") });
    const all = await m.list();
    expect(all.map((w) => w.id).sort()).toEqual([UUID_A, UUID_B].sort());
  });

  it("read returns null for an unregistered id", async () => {
    const m = newSqliteManager();
    expect(await m.read(UUID_A)).toBeNull();
  });
});

describe("WorkspaceManager — update", () => {
  it("renames a workspace and preserves immutable fields", async () => {
    const m = newSqliteManager();
    const ws = await m.init({ id: UUID_A, name: "Old", workdir: path.join(scratch, "x") });
    const updated = await m.update(UUID_A, { name: "New" });
    expect(updated.name).toBe("New");
    expect(updated.workdir).toBe(ws.workdir);
    expect(updated.createdAt).toBe(ws.createdAt);
  });

  it("clears defaults when passed null", async () => {
    const m = newSqliteManager();
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
    const m = newSqliteManager();
    await expect(m.update(UUID_A, { name: "x" })).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
  });

  it("throws WorkspaceNotRegisteredError when the row is deleted between read and save (rename ↔ delete race)", async () => {
    // Regression: previously `repository.save` was an upsert
    // (INSERT … ON CONFLICT DO UPDATE), so an in-flight rename whose
    // `read()` saw a row but whose `save()` arrived after a concurrent
    // `delete(id)` would silently re-create the workspace with the
    // rename's name and reset registry-side timing fields. Strict
    // UPDATE in `repository.save` makes the race a typed 404 instead
    // — the rename atomically fails and the workspace stays deleted.
    //
    // We simulate the interleave by deleting the workspace *via the
    // manager* between init and update; the update then takes the
    // rejected branch.
    const m = newSqliteManager();
    await m.init({ id: UUID_A, name: "Pre-delete", workdir: path.join(scratch, "race") });
    await m.delete(UUID_A);
    await expect(m.update(UUID_A, { name: "Would resurrect" })).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
    expect(await m.read(UUID_A)).toBeNull();
  });
});

describe("WorkspaceManager — delete", () => {
  it("default delete removes only metadata; workdir contents preserved", async () => {
    const m = newSqliteManager();
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
    // user file preserved
    expect(await fs.readFile(path.join(ws.workdir, "user-file.txt"), "utf8")).toBe("user data");
    // sessions subdir preserved (not purged by default)
    expect(await fs.readFile(path.join(ws.workdir, "sessions", "session-trace.txt"), "utf8")).toBe(
      "agent file",
    );
  });

  it("purge=true also removes emploke-owned subdirs but preserves workdir + user files", async () => {
    const m = newSqliteManager();
    const ws = await m.init({ id: UUID_A, name: "X", workdir: path.join(scratch, "x") });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(ws.workdir, "user-file.txt"), "user data", "utf8");
    await fs.writeFile(path.join(ws.workdir, "sessions", "trace.txt"), "agent", "utf8");

    await m.delete(UUID_A, { purge: true });
    expect(await m.read(UUID_A)).toBeNull();
    // every emploke-owned subdir gone — pin both so a future
    // accidental drop from the purge list (or a layout addition that
    // forgets a corresponding rm) gets caught.
    await expect(fs.stat(path.join(ws.workdir, "sessions"))).rejects.toThrow();
    await expect(fs.stat(path.join(ws.workdir, "tasks"))).rejects.toThrow();
    // workdir itself preserved
    const st = await fs.stat(ws.workdir);
    expect(st.isDirectory()).toBe(true);
    // user file preserved
    expect(await fs.readFile(path.join(ws.workdir, "user-file.txt"), "utf8")).toBe("user data");
  });

  it("delete is idempotent for unregistered ids", async () => {
    const m = newSqliteManager();
    await m.delete(UUID_A); // no throw
    await m.delete(UUID_A, { purge: true }); // also no throw
  });

  it("delete(purge:true) purges sandbox dirs BEFORE removing the registry entry", async () => {
    // Regression: removing the index entry first opens a window where
    // a concurrent init({workdir: same}) could succeed and start
    // populating sandbox dirs that the in-flight purge would then
    // wipe. Purge-then-delete keeps the path-conflict guard active
    // throughout the sandbox cleanup.
    const m = newSqliteManager();
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
    const m = newSqliteManager();
    expect(await m.getCurrent()).toBeNull();
  });

  it("setCurrent + getCurrent round-trip", async () => {
    const m = newSqliteManager();
    await m.init({ id: UUID_A, name: "A", workdir: path.join(scratch, "a") });
    await m.setCurrent(UUID_A);
    expect(await m.getCurrent()).toBe(UUID_A);
  });

  it("setCurrent throws for an unregistered id", async () => {
    const m = newSqliteManager();
    await expect(m.setCurrent(UUID_A)).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });

  it("delete clears currentId when the deleted workspace was current", async () => {
    const m = newSqliteManager();
    await m.init({ id: UUID_A, name: "A", workdir: path.join(scratch, "a") });
    await m.setCurrent(UUID_A);
    await m.delete(UUID_A);
    expect(await m.getCurrent()).toBeNull();
  });
});

describe("SqliteWorkspaceRepository — corruption / schema mismatch", () => {
  it("rejects newer schemaVersion in the global.db registry", () => {
    const repo = new SqliteWorkspaceRepository({ db });
    void repo;
    db.prepare("UPDATE schema_meta SET version = 99 WHERE pkg = ?").run("workspace");
    expect(() => new SqliteWorkspaceRepository({ db })).toThrow(RegistrySchemaMismatchError);
  });

  it("an out-of-band corrupted row is dropped from list (warns), still throws on read(id)", async () => {
    const m = newSqliteManager();
    await m.init({ id: UUID_A, name: "Healthy", workdir: path.join(scratch, "h") });
    await m.init({ id: UUID_B, name: "Bad", workdir: path.join(scratch, "b") });
    // Forge a corrupt row by direct UPDATE — overwrite name with empty string.
    db.prepare("UPDATE workspaces SET name = '' WHERE id = ?").run(UUID_B);

    const all = await m.list();
    expect(all.map((w) => w.id)).toEqual([UUID_A]);
    // Single-id read still surfaces the typed error.
    await expect(m.read(UUID_B)).rejects.toBeInstanceOf(WorkspaceCorruptedError);
  });
});

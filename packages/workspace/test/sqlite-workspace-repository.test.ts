import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_FILE } from "../src/constants.js";
import {
  SqliteWorkspaceRepository,
  type Workspace,
  WorkspaceCorruptedError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceManager,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../src/index.js";

let scratch: string;
let db: DatabaseSync;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-sqlite-ws-"));
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
const UUID_BAD = "not-a-uuid";

const sample = (id: string, name: string, workdir: string): Workspace => ({
  id,
  name,
  createdAt: new Date().toISOString(),
  workdir,
});

describe("SqliteWorkspaceRepository — schema bootstrap", () => {
  it("creates schema_meta + workspace_registry + global_state on first open", () => {
    new SqliteWorkspaceRepository({ db });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("schema_meta");
    expect(tables).toContain("workspace_registry");
    expect(tables).toContain("global_state");
  });

  it("registers itself under pkg='workspace' in schema_meta", () => {
    new SqliteWorkspaceRepository({ db });
    const row = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("workspace") as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(1);
  });

  it("re-opening an already-initialised DB is a no-op", () => {
    new SqliteWorkspaceRepository({ db });
    expect(() => new SqliteWorkspaceRepository({ db })).not.toThrow();
  });

  it("throws RegistrySchemaMismatchError when the on-disk version is newer", () => {
    new SqliteWorkspaceRepository({ db });
    db.prepare("UPDATE schema_meta SET version = 99 WHERE pkg = ?").run("workspace");
    expect(() => new SqliteWorkspaceRepository({ db })).toThrow(/schemaVersion 99/);
  });
});

describe("SqliteWorkspaceRepository — create + read round-trip", () => {
  it("create + read returns the same workspace", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const wsdir = path.join(scratch, "p");
    const ws = sample(UUID_A, "Project A", wsdir);
    await repo.create(ws);
    const back = await repo.read(UUID_A);
    expect(back?.id).toBe(UUID_A);
    expect(back?.name).toBe("Project A");
    expect(back?.workdir).toBe(path.resolve(wsdir));
  });

  it("create writes workspace.json metadata next to the workdir", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const wsdir = path.join(scratch, "p");
    await repo.create(sample(UUID_A, "Project A", wsdir));
    const metaStat = await stat(path.join(wsdir, WORKSPACE_FILE));
    expect(metaStat.isFile()).toBe(true);
  });

  it("read returns null for unknown id", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    expect(await repo.read(UUID_A)).toBeNull();
  });

  it("read returns null for malformed id (does not throw)", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    expect(await repo.read(UUID_BAD)).toBeNull();
  });

  it("create throws WorkspaceIdInvalidError for non-UUID ids", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await expect(repo.create(sample(UUID_BAD, "x", scratch))).rejects.toBeInstanceOf(
      WorkspaceIdInvalidError,
    );
  });

  it("create throws WorkspaceIdConflictError when the id is already registered", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "first", path.join(scratch, "a")));
    await expect(
      repo.create(sample(UUID_A, "second", path.join(scratch, "b"))),
    ).rejects.toBeInstanceOf(WorkspaceIdConflictError);
  });

  it("create throws WorkspacePathConflictError when the workdir is already registered", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "first", path.join(scratch, "shared")));
    await expect(
      repo.create(sample(UUID_B, "second", path.join(scratch, "shared"))),
    ).rejects.toBeInstanceOf(WorkspacePathConflictError);
  });
});

describe("SqliteWorkspaceRepository — save (upsert)", () => {
  it("save upserts an existing workspace", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const wsdir = path.join(scratch, "p");
    await repo.create(sample(UUID_A, "first", wsdir));
    await repo.save({ ...sample(UUID_A, "renamed", wsdir) });
    const back = await repo.read(UUID_A);
    expect(back?.name).toBe("renamed");
  });

  it("save throws WorkspacePathConflictError when another id owns the workdir", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "first", path.join(scratch, "a")));
    await repo.create(sample(UUID_B, "second", path.join(scratch, "b")));
    // Try to repoint UUID_B's save to UUID_A's workdir.
    await expect(
      repo.save(sample(UUID_B, "second", path.join(scratch, "a"))),
    ).rejects.toBeInstanceOf(WorkspacePathConflictError);
  });
});

describe("SqliteWorkspaceRepository — list", () => {
  it("returns an empty list when no workspaces are registered", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    expect(await repo.list()).toEqual([]);
  });

  it("returns every registered workspace", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "A", path.join(scratch, "a")));
    await repo.create(sample(UUID_B, "B", path.join(scratch, "b")));
    const all = await repo.list();
    expect(all.map((w) => w.id).sort()).toEqual([UUID_A, UUID_B].sort());
  });

  it("drops a single corrupted workspace from list (does not fail the whole call)", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "good", path.join(scratch, "a")));
    await repo.create(sample(UUID_B, "bad", path.join(scratch, "b")));
    // Corrupt the second workspace's metadata file by writing
    // garbage over the top.
    const fsImport = await import("node:fs/promises");
    await fsImport.writeFile(path.join(scratch, "b", WORKSPACE_FILE), "{");
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(UUID_A);
  });

  it("read still throws for the corrupted single id", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "bad", path.join(scratch, "a")));
    const fsImport = await import("node:fs/promises");
    await fsImport.writeFile(path.join(scratch, "a", WORKSPACE_FILE), "{");
    await expect(repo.read(UUID_A)).rejects.toBeInstanceOf(WorkspaceCorruptedError);
  });
});

describe("SqliteWorkspaceRepository — delete", () => {
  it("removes the registry row and the per-workspace metadata file", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const wsdir = path.join(scratch, "p");
    await repo.create(sample(UUID_A, "x", wsdir));
    await repo.delete(UUID_A);
    expect(await repo.read(UUID_A)).toBeNull();
    const fsImport = await import("node:fs/promises");
    await expect(fsImport.access(path.join(wsdir, WORKSPACE_FILE))).rejects.toBeDefined();
  });

  it("delete on a missing id is a no-op", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await expect(repo.delete(UUID_A)).resolves.toBeUndefined();
  });

  it("delete on malformed id is a no-op (mirrors fs repo)", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await expect(repo.delete(UUID_BAD)).resolves.toBeUndefined();
  });

  it("clears the current-workspace pointer if it was the deleted id", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "x", path.join(scratch, "a")));
    await repo.setCurrent(UUID_A);
    expect(await repo.getCurrent()).toBe(UUID_A);
    await repo.delete(UUID_A);
    expect(await repo.getCurrent()).toBeNull();
  });
});

describe("SqliteWorkspaceRepository — current pointer", () => {
  it("getCurrent returns null on a fresh repo", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    expect(await repo.getCurrent()).toBeNull();
  });

  it("setCurrent persists the value across reads", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "x", path.join(scratch, "a")));
    await repo.setCurrent(UUID_A);
    expect(await repo.getCurrent()).toBe(UUID_A);
  });

  it("setCurrent throws WorkspaceNotRegisteredError for an unknown id", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await expect(repo.setCurrent(UUID_A)).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });

  it("setCurrent throws WorkspaceNotRegisteredError for malformed id", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await expect(repo.setCurrent(UUID_BAD)).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });

  it("setCurrent updates last_opened_at on the registry row", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "x", path.join(scratch, "a")));
    const before = db
      .prepare("SELECT last_opened_at FROM workspace_registry WHERE id = ?")
      .get(UUID_A) as { last_opened_at: string | null };
    expect(before.last_opened_at).toBeNull();
    await repo.setCurrent(UUID_A);
    const after = db
      .prepare("SELECT last_opened_at FROM workspace_registry WHERE id = ?")
      .get(UUID_A) as { last_opened_at: string | null };
    expect(after.last_opened_at).not.toBeNull();
  });
});

describe("SqliteWorkspaceRepository — atomic save crash safety", () => {
  it("metadata file is written before registry row (no orphan registry entries on crash)", async () => {
    // We can't easily kill the process mid-save in a unit test, but
    // we can assert ordering via a side effect. Use a custom DB whose
    // INSERT trigger throws after the metadata file is written; the
    // workspace.json should already exist on disk after the throw.
    const repo = new SqliteWorkspaceRepository({ db });
    db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON workspace_registry
             BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`);
    const wsdir = path.join(scratch, "p");
    await expect(repo.create(sample(UUID_A, "x", wsdir))).rejects.toThrow(/simulated crash/);
    // Metadata file should exist (written before the failing INSERT).
    const fsImport = await import("node:fs/promises");
    await expect(fsImport.access(path.join(wsdir, WORKSPACE_FILE))).resolves.toBeUndefined();
    // Registry row should NOT exist.
    expect(await repo.read(UUID_A)).toBeNull();
  });
});

describe("WorkspaceManager backed by SqliteWorkspaceRepository", () => {
  it("init + read round-trip via the manager works exactly like the FS repo", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const m = new WorkspaceManager(repo);
    const wsdir = path.join(scratch, "p");
    const ws = await m.init({ id: UUID_A, name: "Project", workdir: wsdir });
    expect(ws.id).toBe(UUID_A);
    expect(ws.name).toBe("Project");
    // Standard subdirs are created by the manager (the repo doesn't do
    // this — it just persists the metadata + registry row).
    const fsImport = await import("node:fs/promises");
    for (const sub of ["sessions", "tasks", "catalog"]) {
      const st = await fsImport.stat(path.join(wsdir, sub));
      expect(st.isDirectory()).toBe(true);
    }
    const back = await m.read(UUID_A);
    expect(back?.name).toBe("Project");
  });
});

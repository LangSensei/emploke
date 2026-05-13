import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteWorkspaceRepository,
  Workspace,
  WorkspaceCorruptedError,
  WorkspaceIdConflictError,
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

const sample = (id: string, name: string, workdir: string): Workspace =>
  Workspace.create({ id, name, workdir });

describe("SqliteWorkspaceRepository — schema bootstrap", () => {
  it("creates schema_meta + workspaces + global_state on first open", () => {
    new SqliteWorkspaceRepository({ db });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("schema_meta");
    expect(tables).toContain("workspaces");
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
    await repo.create(sample(UUID_A, "Project A", wsdir));
    const back = await repo.read(UUID_A);
    expect(back?.id).toBe(UUID_A);
    expect(back?.name).toBe("Project A");
    expect(back?.workdir).toBe(path.resolve(wsdir));
  });

  it("create persists defaults round-trip", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const wsdir = path.join(scratch, "p");
    await repo.create(
      Workspace.create({
        id: UUID_A,
        name: "Project A",
        workdir: wsdir,
        defaults: { runtime: "copilot", agent: "writer" },
      }),
    );
    const back = await repo.read(UUID_A);
    expect(back?.defaults).toEqual({ runtime: "copilot", agent: "writer" });
  });

  it("read returns null for unknown id", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    expect(await repo.read(UUID_A)).toBeNull();
  });

  it("read returns null for malformed id (does not throw)", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    expect(await repo.read(UUID_BAD)).toBeNull();
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
  it("save upserts an existing workspace's mutable fields", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const wsdir = path.join(scratch, "p");
    const original = sample(UUID_A, "first", wsdir);
    await repo.create(original);
    const renamed = original.withMetadata({ name: "renamed" });
    await repo.save(renamed);
    const back = await repo.read(UUID_A);
    expect(back?.name).toBe("renamed");
  });

  it("save throws WorkspacePathConflictError when another id owns the workdir", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "first", path.join(scratch, "a")));
    await repo.create(sample(UUID_B, "second", path.join(scratch, "b")));
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
    await repo.create(sample(UUID_B, "ok", path.join(scratch, "b")));
    db.prepare("UPDATE workspaces SET name = '' WHERE id = ?").run(UUID_B);
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(UUID_A);
  });

  it("read still throws for the corrupted single id", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await repo.create(sample(UUID_A, "ok", path.join(scratch, "a")));
    db.prepare("UPDATE workspaces SET name = '' WHERE id = ?").run(UUID_A);
    await expect(repo.read(UUID_A)).rejects.toBeInstanceOf(WorkspaceCorruptedError);
  });
});

describe("SqliteWorkspaceRepository — delete", () => {
  it("removes the registry row", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const wsdir = path.join(scratch, "p");
    await repo.create(sample(UUID_A, "x", wsdir));
    await repo.delete(UUID_A);
    expect(await repo.read(UUID_A)).toBeNull();
  });

  it("delete on a missing id is a no-op", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    await expect(repo.delete(UUID_A)).resolves.toBeUndefined();
  });

  it("delete on malformed id is a no-op", async () => {
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
    const before = db.prepare("SELECT last_opened_at FROM workspaces WHERE id = ?").get(UUID_A) as {
      last_opened_at: string | null;
    };
    expect(before.last_opened_at).toBeNull();
    await repo.setCurrent(UUID_A);
    const after = db.prepare("SELECT last_opened_at FROM workspaces WHERE id = ?").get(UUID_A) as {
      last_opened_at: string | null;
    };
    expect(after.last_opened_at).not.toBeNull();
  });
});

describe("WorkspaceManager backed by SqliteWorkspaceRepository", () => {
  it("init + read round-trip via the manager works", async () => {
    const repo = new SqliteWorkspaceRepository({ db });
    const m = new WorkspaceManager(repo);
    const wsdir = path.join(scratch, "p");
    const ws = await m.init({ id: UUID_A, name: "Project", workdir: wsdir });
    expect(ws.id).toBe(UUID_A);
    expect(ws.name).toBe("Project");
    const fsImport = await import("node:fs/promises");
    for (const sub of ["sessions", "tasks", "catalog"]) {
      const st = await fsImport.stat(path.join(wsdir, sub));
      expect(st.isDirectory()).toBe(true);
    }
    const back = await m.read(UUID_A);
    expect(back?.name).toBe("Project");
  });
});

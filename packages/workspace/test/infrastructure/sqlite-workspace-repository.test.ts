import "reflect-metadata";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryNotBootstrappedError } from "../../src/domain/errors.js";
import {
  RegistrySchemaMismatchError,
  WorkspaceCorruptedError,
  WorkspaceIdConflictError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../../src/index.js";
import {
  bootstrapWorkspaceRegistryDb,
  SqliteWorkspaceRepository,
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
} from "../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_BAD_FOR_ID = "not-a-uuid";

let scratch: string;
let db: DatabaseSync;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-sqlite-ws-"));
  db = new DatabaseSync(":memory:");
  await bootstrapWorkspaceRegistryDb(db);
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    // already closed
  }
  await rm(scratch, { recursive: true, force: true });
});

function sample(id: string, name: string, workspaceDir: string): Workspace {
  return Workspace.register({
    id: WorkspaceId.of(id),
    name: WorkspaceName.of(name),
    workspaceDir: WorkspaceDir.of(workspaceDir),
    now: new Date().toISOString(),
  });
}

describe("SqliteWorkspaceRepository — schema bootstrap", () => {
  it("coordinator creates schema_meta + workspaces + global_state tables", () => {
    new SqliteWorkspaceRepository(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("schema_meta");
    expect(tables).toContain("workspaces");
    expect(tables).toContain("global_state");
  });

  it("repository finds pkg='workspace' in schema_meta at the expected version", () => {
    new SqliteWorkspaceRepository(db);
    const row = db.prepare("SELECT version FROM schema_meta WHERE pkg = ?").get("workspace") as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(2);
  });

  it("re-opening an already-initialised DB is a no-op", () => {
    new SqliteWorkspaceRepository(db);
    expect(() => new SqliteWorkspaceRepository(db)).not.toThrow();
  });

  it("throws RegistrySchemaMismatchError when the on-disk version is newer", () => {
    new SqliteWorkspaceRepository(db);
    db.prepare("UPDATE schema_meta SET version = 99 WHERE pkg = ?").run("workspace");
    expect(() => new SqliteWorkspaceRepository(db)).toThrow(RegistrySchemaMismatchError);
  });

  it("throws RegistryNotBootstrappedError when constructed against a DB the coordinator never touched", () => {
    const freshDb = new DatabaseSync(":memory:");
    try {
      expect(() => new SqliteWorkspaceRepository(freshDb)).toThrow(RegistryNotBootstrappedError);
    } finally {
      freshDb.close();
    }
  });
});

describe("SqliteWorkspaceRepository — create + findById round-trip", () => {
  it("create + findById returns the same workspace", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    const wsdir = path.join(scratch, "p");
    await repo.create(sample(UUID_A, "Project A", wsdir));
    const back = await repo.findById(WorkspaceId.of(UUID_A));
    expect(back?.id.value).toBe(UUID_A);
    expect(back?.name.value).toBe("Project A");
    expect(back?.workspaceDir.value).toBe(path.resolve(wsdir));
  });

  it("findById returns null for unknown id", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    expect(await repo.findById(WorkspaceId.of(UUID_A))).toBeNull();
  });

  it("create throws WorkspaceIdConflictError when the id is already registered", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "first", path.join(scratch, "a")));
    await expect(
      repo.create(sample(UUID_A, "second", path.join(scratch, "b"))),
    ).rejects.toBeInstanceOf(WorkspaceIdConflictError);
  });

  it("create throws WorkspacePathConflictError when the workspaceDir is already registered", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "first", path.join(scratch, "shared")));
    await expect(
      repo.create(sample(UUID_B, "second", path.join(scratch, "shared"))),
    ).rejects.toBeInstanceOf(WorkspacePathConflictError);
  });
});

describe("SqliteWorkspaceRepository — save (strict update)", () => {
  it("save updates an existing workspace's mutable fields", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    const wsdir = path.join(scratch, "p");
    const original = sample(UUID_A, "first", wsdir);
    await repo.create(original);
    original.rename(WorkspaceName.of("renamed"), new Date().toISOString());
    await repo.save(original);
    const back = await repo.findById(WorkspaceId.of(UUID_A));
    expect(back?.name.value).toBe("renamed");
  });

  it("save throws WorkspaceNotRegisteredError when the row was deleted concurrently", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    const original = sample(UUID_A, "first", path.join(scratch, "p"));
    await repo.create(original);
    await repo.delete(WorkspaceId.of(UUID_A));
    original.rename(WorkspaceName.of("would-resurrect"), new Date().toISOString());
    await expect(repo.save(original)).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
    expect(await repo.findById(WorkspaceId.of(UUID_A))).toBeNull();
  });

  it("save throws WorkspaceNotRegisteredError for an id that was never registered", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await expect(
      repo.save(sample(UUID_A, "ghost", path.join(scratch, "p"))),
    ).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
  });
});

describe("SqliteWorkspaceRepository — list", () => {
  it("returns an empty list when no workspaces are registered", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    expect(await repo.list()).toEqual([]);
  });

  it("returns every registered workspace", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "A", path.join(scratch, "a")));
    await repo.create(sample(UUID_B, "B", path.join(scratch, "b")));
    const all = await repo.list();
    expect(all.map((w) => w.id.value).sort()).toEqual([UUID_A, UUID_B].sort());
  });

  it("drops a single corrupted workspace from list (does not fail the whole call)", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "good", path.join(scratch, "a")));
    await repo.create(sample(UUID_B, "ok", path.join(scratch, "b")));
    db.prepare("UPDATE workspaces SET name = '' WHERE id = ?").run(UUID_B);
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id.value).toBe(UUID_A);
  });

  it("findById still throws for the corrupted single id", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "ok", path.join(scratch, "a")));
    db.prepare("UPDATE workspaces SET name = '' WHERE id = ?").run(UUID_A);
    await expect(repo.findById(WorkspaceId.of(UUID_A))).rejects.toBeInstanceOf(
      WorkspaceCorruptedError,
    );
  });
});

describe("SqliteWorkspaceRepository — delete", () => {
  it("removes the registry row", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "x", path.join(scratch, "p")));
    await repo.delete(WorkspaceId.of(UUID_A));
    expect(await repo.findById(WorkspaceId.of(UUID_A))).toBeNull();
  });

  it("delete on a missing id is a no-op", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await expect(repo.delete(WorkspaceId.of(UUID_A))).resolves.toBeUndefined();
  });

  it("clears the current-workspace pointer if it was the deleted id", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "x", path.join(scratch, "a")));
    await repo.setCurrent(WorkspaceId.of(UUID_A));
    expect(await repo.getCurrent()).toBe(UUID_A);
    await repo.delete(WorkspaceId.of(UUID_A));
    expect(await repo.getCurrent()).toBeNull();
  });
});

describe("SqliteWorkspaceRepository — current pointer", () => {
  it("getCurrent returns null on a fresh repo", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    expect(await repo.getCurrent()).toBeNull();
  });

  it("setCurrent persists the value across reads", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "x", path.join(scratch, "a")));
    await repo.setCurrent(WorkspaceId.of(UUID_A));
    expect(await repo.getCurrent()).toBe(UUID_A);
  });

  it("setCurrent throws WorkspaceNotRegisteredError for an unknown id", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await expect(repo.setCurrent(WorkspaceId.of(UUID_A))).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
  });

  it("setCurrent updates last_opened_at on the registry row", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "x", path.join(scratch, "a")));
    const before = db.prepare("SELECT last_opened_at FROM workspaces WHERE id = ?").get(UUID_A) as {
      last_opened_at: string | null;
    };
    expect(before.last_opened_at).toBeNull();
    await repo.setCurrent(WorkspaceId.of(UUID_A));
    const after = db.prepare("SELECT last_opened_at FROM workspaces WHERE id = ?").get(UUID_A) as {
      last_opened_at: string | null;
    };
    expect(after.last_opened_at).not.toBeNull();
  });
});

describe("SqliteWorkspaceRepository — close()", () => {
  it("releases the file handle so the file can be unlinked", async () => {
    const dbFile = path.join(scratch, "global.db");
    const fileDb = new DatabaseSync(dbFile);
    await bootstrapWorkspaceRegistryDb(fileDb);
    const repo = new SqliteWorkspaceRepository(fileDb);
    await repo.create(sample(UUID_A, "x", path.join(scratch, "x")));

    repo.close();
    // idempotent
    repo.close();

    await expect(unlink(dbFile)).resolves.toBeUndefined();
  });
});

describe("regressions covered elsewhere", () => {
  // Kept here as a marker so future maintainers understand the
  // coverage split — these legacy tests have moved into Workspace
  // aggregate tests under `domain/workspace.test.ts`.
  it.skip("displaces tests for raw row corruption (see domain/workspace.test.ts)", () => {});
  void UUID_BAD_FOR_ID;
});

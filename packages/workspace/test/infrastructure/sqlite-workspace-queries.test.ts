import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapWorkspaceRegistryDb,
  SqliteWorkspaceQueries,
  SqliteWorkspaceRepository,
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
} from "../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let scratch: string;
let db: DatabaseSync;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-sqlite-ws-queries-"));
  db = new DatabaseSync(":memory:");
  await bootstrapWorkspaceRegistryDb(db);
});

afterEach(async () => {
  try {
    db.close();
  } catch {}
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

describe("SqliteWorkspaceQueries", () => {
  it("getById returns the full view for a registered workspace", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "Project", path.join(scratch, "p")));
    const q = new SqliteWorkspaceQueries(db);
    const view = await q.getById(UUID_A);
    expect(view).not.toBeNull();
    expect(view).toMatchObject({
      id: UUID_A,
      name: "Project",
      workspaceDir: path.resolve(path.join(scratch, "p")),
    });
    expect(typeof view!.createdAt).toBe("string");
  });

  it("getById returns null for an unknown id", async () => {
    const q = new SqliteWorkspaceQueries(db);
    expect(await q.getById(UUID_A)).toBeNull();
  });

  it("getById returns null for a malformed id (no throw)", async () => {
    const q = new SqliteWorkspaceQueries(db);
    expect(await q.getById("not-a-uuid")).toBeNull();
  });

  it("list returns every registered workspace as a summary", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "A", path.join(scratch, "a")));
    await repo.create(sample(UUID_B, "B", path.join(scratch, "b")));
    const q = new SqliteWorkspaceQueries(db);
    const list = await q.list();
    expect(list.map((v) => v.id).sort()).toEqual([UUID_A, UUID_B].sort());
    expect(list[0]).toHaveProperty("name");
    expect(list[0]).toHaveProperty("workspaceDir");
  });

  it("list returns [] on an empty registry", async () => {
    const q = new SqliteWorkspaceQueries(db);
    expect(await q.list()).toEqual([]);
  });

  it("getCurrentId returns null when nothing is selected", async () => {
    const q = new SqliteWorkspaceQueries(db);
    expect(await q.getCurrentId()).toBeNull();
  });

  it("getCurrentId returns the selected id after setCurrent", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "X", path.join(scratch, "a")));
    await repo.setCurrent(WorkspaceId.of(UUID_A));
    const q = new SqliteWorkspaceQueries(db);
    expect(await q.getCurrentId()).toBe(UUID_A);
  });

  it("getCurrent returns the full view of the selected workspace", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "X", path.join(scratch, "a")));
    await repo.setCurrent(WorkspaceId.of(UUID_A));
    const q = new SqliteWorkspaceQueries(db);
    const view = await q.getCurrent();
    expect(view?.id).toBe(UUID_A);
    expect(view?.name).toBe("X");
  });

  it("getCurrent returns null when the selected id was unregistered out-of-band", async () => {
    const repo = new SqliteWorkspaceRepository(db);
    await repo.create(sample(UUID_A, "X", path.join(scratch, "a")));
    await repo.setCurrent(WorkspaceId.of(UUID_A));
    // Manually clear the row but leave the pointer dangling (simulates
    // out-of-band SQL or a race the repo's delete() would clean up).
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(UUID_A);
    const q = new SqliteWorkspaceQueries(db);
    expect(await q.getCurrent()).toBeNull();
  });
});

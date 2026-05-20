import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MikroORM } from "@mikro-orm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceIdConflictError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "../../src/index.js";
import {
  MikroWorkspaceQueries,
  MikroWorkspaceRepository,
  makeTestWorkspaceContext,
  openTestWorkspaceOrm,
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
} from "../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let scratch: string;
let orm: MikroORM;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-mikro-ws-"));
  orm = await openTestWorkspaceOrm();
});

afterEach(async () => {
  await orm.close(true);
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

describe("MikroWorkspaceRepository — persist + findById round-trip", () => {
  it("em.persist + em.flush + findById returns the same workspace", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    const wsDir = path.join(scratch, "p");
    em.persist(sample(UUID_A, "Project A", wsDir));
    await em.flush();

    const back = await repo.findById(WorkspaceId.of(UUID_A));
    expect(back?.id).toBe(UUID_A);
    expect(back?.name).toBe("Project A");
    expect(back?.workspaceDir).toBe(path.resolve(wsDir));
  });

  it("findById returns null for unknown id", async () => {
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(orm.em.fork()));
    expect(await repo.findById(WorkspaceId.of(UUID_A))).toBeNull();
  });
});

describe("MikroWorkspaceRepository — add", () => {
  it("happy path: persists the aggregate and findById sees it", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    const wsDir = path.join(scratch, "p");
    await repo.add(sample(UUID_A, "Project A", wsDir));

    const back = await repo.findById(WorkspaceId.of(UUID_A));
    expect(back?.id).toBe(UUID_A);
    expect(back?.name).toBe("Project A");
    expect(back?.workspaceDir).toBe(path.resolve(wsDir));
  });

  it("translates a PRIMARY KEY collision into WorkspaceIdConflictError", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    await repo.add(sample(UUID_A, "first", path.join(scratch, "a")));
    // Same id, distinct path -> PRIMARY KEY collision on `id`.
    await expect(
      repo.add(sample(UUID_A, "second", path.join(scratch, "b"))),
    ).rejects.toBeInstanceOf(WorkspaceIdConflictError);
  });

  it("translates a UNIQUE(workspace_dir) collision into WorkspacePathConflictError", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    const shared = path.join(scratch, "shared");
    await repo.add(sample(UUID_A, "first", shared));
    // Distinct id, same workspaceDir -> UNIQUE collision on `workspace_dir`.
    await expect(repo.add(sample(UUID_B, "second", shared))).rejects.toBeInstanceOf(
      WorkspacePathConflictError,
    );
  });
});

describe("MikroWorkspaceRepository — delete", () => {
  it("removes the registry row via em.remove + flush", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    em.persist(sample(UUID_A, "x", path.join(scratch, "p")));
    await em.flush();

    await repo.delete(WorkspaceId.of(UUID_A));
    await em.flush();
    expect(await repo.findById(WorkspaceId.of(UUID_A))).toBeNull();
  });

  it("delete on a missing id is a no-op", async () => {
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(orm.em.fork()));
    await expect(repo.delete(WorkspaceId.of(UUID_A))).resolves.toBeUndefined();
  });

  it("clears the current-workspace pointer if it was the deleted id", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    em.persist(sample(UUID_A, "x", path.join(scratch, "a")));
    await em.flush();
    await repo.setCurrent(WorkspaceId.of(UUID_A));
    expect(await repo.getCurrent()).toBe(UUID_A);

    await repo.delete(WorkspaceId.of(UUID_A));
    await em.flush();
    expect(await repo.getCurrent()).toBeNull();
  });
});

describe("MikroWorkspaceRepository — current pointer", () => {
  it("getCurrent returns null on a fresh repo", async () => {
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(orm.em.fork()));
    expect(await repo.getCurrent()).toBeNull();
  });

  it("setCurrent persists the value across reads", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    em.persist(sample(UUID_A, "x", path.join(scratch, "a")));
    await em.flush();

    await repo.setCurrent(WorkspaceId.of(UUID_A));
    expect(await repo.getCurrent()).toBe(UUID_A);
  });

  it("setCurrent throws WorkspaceNotRegisteredError for an unknown id", async () => {
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(orm.em.fork()));
    await expect(repo.setCurrent(WorkspaceId.of(UUID_A))).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
  });
});

describe("MikroWorkspaceQueries", () => {
  it("getById returns the full view for a registered workspace", async () => {
    const em = orm.em.fork();
    em.persist(sample(UUID_A, "Project", path.join(scratch, "p")));
    await em.flush();

    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(em));
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
    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(orm.em.fork()));
    expect(await q.getById(UUID_A)).toBeNull();
  });

  it("getById returns null for a malformed id (no throw)", async () => {
    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(orm.em.fork()));
    expect(await q.getById("not-a-uuid")).toBeNull();
  });

  it("list returns every registered workspace as a summary", async () => {
    const em = orm.em.fork();
    em.persist(sample(UUID_A, "A", path.join(scratch, "a")));
    em.persist(sample(UUID_B, "B", path.join(scratch, "b")));
    await em.flush();

    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(em));
    const list = await q.list();
    expect(list.map((v) => v.id).sort()).toEqual([UUID_A, UUID_B].sort());
    expect(list[0]).toHaveProperty("name");
    expect(list[0]).toHaveProperty("workspaceDir");
  });

  it("list returns [] on an empty registry", async () => {
    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(orm.em.fork()));
    expect(await q.list()).toEqual([]);
  });

  it("getCurrentId returns null when nothing is selected", async () => {
    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(orm.em.fork()));
    expect(await q.getCurrentId()).toBeNull();
  });

  it("getCurrentId returns the selected id after setCurrent", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    em.persist(sample(UUID_A, "X", path.join(scratch, "a")));
    await em.flush();
    await repo.setCurrent(WorkspaceId.of(UUID_A));

    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(em));
    expect(await q.getCurrentId()).toBe(UUID_A);
  });

  it("getCurrent returns the full view of the selected workspace", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    em.persist(sample(UUID_A, "X", path.join(scratch, "a")));
    await em.flush();
    await repo.setCurrent(WorkspaceId.of(UUID_A));

    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(em));
    const view = await q.getCurrent();
    expect(view?.id).toBe(UUID_A);
    expect(view?.name).toBe("X");
  });
});

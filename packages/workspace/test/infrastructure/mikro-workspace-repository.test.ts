import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MikroORM } from "@mikro-orm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const persisted = await repo.add(sample(UUID_A, "Project A", wsDir));
    await em.flush();

    expect(persisted.id).toBe(UUID_A);
    const back = await repo.findById(WorkspaceId.of(UUID_A));
    expect(back?.id).toBe(UUID_A);
    expect(back?.name).toBe("Project A");
    expect(back?.workspaceDir).toBe(path.resolve(wsDir));
  });

  it("PRIMARY KEY collision surfaces from the SQL layer at flush time", async () => {
    // Phase 2: repository.add no longer translates UNIQUE violations;
    // ValidationBehavior pre-checks id/path uniqueness (via repo.findById /
    // findByPath) so 99.999% of conflicts never reach the SQL layer.
    // A residual TOCTOU race produces a raw MikroORM exception which the
    // wire layer maps to 500.
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    await repo.add(sample(UUID_A, "first", path.join(scratch, "a")));
    await em.flush();
    await repo.add(sample(UUID_A, "second", path.join(scratch, "b")));
    await expect(em.flush()).rejects.toThrow();
  });
});

describe("MikroWorkspaceRepository — findByPath", () => {
  it("returns the aggregate when a workspace occupies the path", async () => {
    const em = orm.em.fork();
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(em));
    const wsDir = path.join(scratch, "shared");
    await repo.add(sample(UUID_A, "first", wsDir));
    await em.flush();
    const back = await repo.findByPath(path.resolve(wsDir));
    expect(back?.id).toBe(UUID_A);
  });

  it("returns null when no workspace is at the path", async () => {
    const repo = new MikroWorkspaceRepository(makeTestWorkspaceContext(orm.em.fork()));
    expect(await repo.findByPath(path.join(scratch, "nope"))).toBeNull();
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
    // register sets lastOpenedAt = now (registration is implicit first-open).
    expect(typeof view!.lastOpenedAt).toBe("string");
  });

  it("getById returns null for an unknown id", async () => {
    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(orm.em.fork()));
    expect(await q.getById(UUID_A)).toBeNull();
  });

  it("getById returns null for a malformed id (no throw)", async () => {
    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(orm.em.fork()));
    expect(await q.getById("not-a-uuid")).toBeNull();
  });

  it("list returns workspaces ordered by lastOpenedAt DESC (most-recently-opened first)", async () => {
    const em = orm.em.fork();
    // sample() uses Workspace.register with `now = new Date().toISOString()`;
    // a tiny delay between persists guarantees distinct lastOpenedAt values.
    em.persist(sample(UUID_A, "A", path.join(scratch, "a")));
    await em.flush();
    await new Promise((r) => setTimeout(r, 5));
    em.persist(sample(UUID_B, "B", path.join(scratch, "b")));
    await em.flush();

    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(em));
    const list = await q.list();
    expect(list.map((v) => v.id)).toEqual([UUID_B, UUID_A]);
    expect(list[0]).toHaveProperty("name");
    expect(list[0]).toHaveProperty("workspaceDir");
    expect(list[0]).toHaveProperty("lastOpenedAt");
  });

  it("list returns [] on an empty registry", async () => {
    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(orm.em.fork()));
    expect(await q.list()).toEqual([]);
  });

  it("getLastOpenedId returns null on an empty registry", async () => {
    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(orm.em.fork()));
    expect(await q.getLastOpenedId()).toBeNull();
  });

  it("getLastOpenedId returns the most-recently-opened workspace's id", async () => {
    const em = orm.em.fork();
    em.persist(sample(UUID_A, "A", path.join(scratch, "a")));
    await em.flush();
    await new Promise((r) => setTimeout(r, 5));
    em.persist(sample(UUID_B, "B", path.join(scratch, "b")));
    await em.flush();

    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(em));
    expect(await q.getLastOpenedId()).toBe(UUID_B);
  });

  it("getLastOpened returns the full view of the most-recently-opened workspace", async () => {
    const em = orm.em.fork();
    em.persist(sample(UUID_A, "X", path.join(scratch, "a")));
    await em.flush();

    const q = new MikroWorkspaceQueries(makeTestWorkspaceContext(em));
    const view = await q.getLastOpened();
    expect(view?.id).toBe(UUID_A);
    expect(view?.name).toBe("X");
    expect(typeof view?.lastOpenedAt).toBe("string");
  });
});

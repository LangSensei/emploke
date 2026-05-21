import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
  WorkspacePathConflictError,
} from "../src/index.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "./_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let scratch: string;
let sys: WorkspaceTestSubsystem;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-register-"));
  sys = await setupWorkspaceTestSubsystem();
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
  await rm(scratch, { recursive: true, force: true });
});

describe("WorkspaceService.register", () => {
  it("creates workspaceDir + sessions/tasks subdirs and persists the row", async () => {
    const wsDir = path.join(scratch, "p");
    const result = await sys.service.register({
      id: UUID_A,
      workspaceDir: wsDir,
      name: "My Project",
    });
    expect(result.id).toBe(UUID_A);

    const view = await sys.queries.getById(UUID_A);
    expect(view).not.toBeNull();
    expect(view?.name).toBe("My Project");
    expect(view?.workspaceDir).toBe(path.resolve(wsDir));

    expect((await stat(wsDir)).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "sessions"))).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "tasks"))).isDirectory()).toBe(true);
    await expect(stat(path.join(wsDir, "catalog"))).rejects.toThrow();
  });

  it("rejects an invalid display name", async () => {
    await expect(
      sys.service.register({ id: UUID_A, workspaceDir: path.join(scratch, "x"), name: "" }),
    ).rejects.toBeInstanceOf(WorkspaceNameInvalidError);
    expect(await sys.queries.getById(UUID_A)).toBeNull();
  });

  it("rejects a non-UUID id", async () => {
    await expect(
      sys.service.register({
        id: "not-a-uuid",
        workspaceDir: path.join(scratch, "x"),
        name: "Project",
      }),
    ).rejects.toBeInstanceOf(WorkspaceIdInvalidError);
  });

  it("rejects an id collision", async () => {
    const wsDir1 = path.join(scratch, "p1");
    const wsDir2 = path.join(scratch, "p2");
    await sys.service.register({ id: UUID_A, workspaceDir: wsDir1, name: "first" });
    await expect(
      sys.service.register({ id: UUID_A, workspaceDir: wsDir2, name: "dupe id" }),
    ).rejects.toBeInstanceOf(WorkspaceIdConflictError);
  });

  it("rejects a path collision with a typed WorkspacePathConflictError", async () => {
    const wsDir = path.join(scratch, "shared");
    await sys.service.register({ id: UUID_A, workspaceDir: wsDir, name: "first" });
    await expect(
      sys.service.register({ id: UUID_B, workspaceDir: wsDir, name: "second" }),
    ).rejects.toBeInstanceOf(WorkspacePathConflictError);
  });
});

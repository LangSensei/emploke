import "reflect-metadata";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RegisterWorkspaceCommand,
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
  WorkspacePathConflictError,
} from "../../../src/index.js";
import { WorkspaceRegistered } from "../../../src/testing.js";
import {
  registerTestWorkspace,
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "../../_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let scratch: string;
let sys: WorkspaceTestSubsystem;
let publishedEvents: unknown[];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-register-handler-"));
  sys = await setupWorkspaceTestSubsystem();
  publishedEvents = [];
  vi.spyOn(sys.mediator, "publish").mockImplementation(async (evt) => {
    publishedEvents.push(evt);
  });
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
  await rm(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("RegisterWorkspaceCommandHandler (Phase 2 / MikroORM)", () => {
  it("creates workspaceDir + sessions/tasks subdirs and persists the workspace", async () => {
    const wsDir = path.join(scratch, "p");
    const id = await registerTestWorkspace(sys, {
      id: UUID_A,
      workspaceDir: wsDir,
      name: "My Project",
    });
    expect(id).toBe(UUID_A);

    const view = await sys.queries.getById(UUID_A);
    expect(view).not.toBeNull();
    expect(view!.name).toBe("My Project");
    expect(view!.workspaceDir).toBe(path.resolve(wsDir));

    expect((await stat(wsDir)).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "sessions"))).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "tasks"))).isDirectory()).toBe(true);
    // no catalog/ subdir created — catalog content lives in workspace.db
    await expect(stat(path.join(wsDir, "catalog"))).rejects.toThrow();
  });

  it("publishes WorkspaceRegistered after the unit-of-work flush", async () => {
    const wsDir = path.join(scratch, "p");
    await registerTestWorkspace(sys, { id: UUID_A, workspaceDir: wsDir, name: "Project" });

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toBeInstanceOf(WorkspaceRegistered);
    const evt = publishedEvents[0] as WorkspaceRegistered;
    expect(evt.id.value).toBe(UUID_A);
  });

  it("rejects an invalid display name", async () => {
    await expect(
      sys.mediator.send(new RegisterWorkspaceCommand(UUID_A, path.join(scratch, "x"), "")),
    ).rejects.toBeInstanceOf(WorkspaceNameInvalidError);
    expect(await sys.queries.getById(UUID_A)).toBeNull();
  });

  it("rejects a non-UUID id", async () => {
    await expect(
      sys.mediator.send(
        new RegisterWorkspaceCommand("not-a-uuid", path.join(scratch, "x"), "Project"),
      ),
    ).rejects.toBeInstanceOf(WorkspaceIdInvalidError);
  });

  it("surfaces a path conflict as WorkspacePathConflictError", async () => {
    const wsDir = path.join(scratch, "shared");
    await registerTestWorkspace(sys, { id: UUID_A, workspaceDir: wsDir, name: "first" });
    // Phase 2 routes a SQLite UNIQUE constraint on `workspace_dir`
    // through the register handler, which translates
    // `UniqueConstraintViolationException` into the typed
    // `WorkspacePathConflictError` the wire layer maps to HTTP 409.
    await expect(
      sys.mediator.send(new RegisterWorkspaceCommand(UUID_B, wsDir, "second")),
    ).rejects.toBeInstanceOf(WorkspacePathConflictError);
  });

  // Sanity check: the typed Phase-1 error subclass is still exported
  // for downstream consumers that catch it, even though Phase 2's
  // constraint-driven enforcement makes the constructor path unused
  // in the workspace pkg itself.
  it("exports WorkspacePathConflictError for downstream catch handlers", () => {
    expect(typeof WorkspacePathConflictError).toBe("function");
  });
});

import "reflect-metadata";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterWorkspaceCommand, UnregisterWorkspaceCommand } from "../../../src/index.js";
import { WorkspaceUnregistered } from "../../../src/testing.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "../../_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

let scratch: string;
let sys: WorkspaceTestSubsystem;
let publishedEvents: unknown[];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-unregister-"));
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

async function seedOnDisk(wsDir: string): Promise<void> {
  await sys.mediator.send(new RegisterWorkspaceCommand(UUID_A, wsDir, "X"));
  await mkdir(path.join(wsDir, "sessions"), { recursive: true });
  await mkdir(path.join(wsDir, "tasks"), { recursive: true });
  publishedEvents.length = 0; // drain the WorkspaceRegistered event
}

describe("UnregisterWorkspaceCommandHandler (Phase 2 / MikroORM)", () => {
  it("default delete removes only metadata; user files preserved", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await writeFile(path.join(wsDir, "user-file.txt"), "user data", "utf8");
    await writeFile(path.join(wsDir, "sessions", "trace.txt"), "agent file", "utf8");

    await sys.mediator.send(new UnregisterWorkspaceCommand(UUID_A, false));

    expect(await sys.queries.getById(UUID_A)).toBeNull();
    expect((await stat(path.join(wsDir, "user-file.txt"))).isFile()).toBe(true);
    expect((await stat(path.join(wsDir, "sessions", "trace.txt"))).isFile()).toBe(true);
  });

  it("purge=true removes emploke-owned subdirs but preserves workspaceDir + user files", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await writeFile(path.join(wsDir, "user-file.txt"), "user data", "utf8");
    await writeFile(path.join(wsDir, "sessions", "trace.txt"), "agent file", "utf8");

    await sys.mediator.send(new UnregisterWorkspaceCommand(UUID_A, true));

    await expect(stat(path.join(wsDir, "sessions"))).rejects.toThrow();
    await expect(stat(path.join(wsDir, "tasks"))).rejects.toThrow();
    expect((await stat(wsDir)).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "user-file.txt"))).isFile()).toBe(true);
  });

  it("publishes WorkspaceUnregistered after the unit-of-work flush", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await sys.mediator.send(new UnregisterWorkspaceCommand(UUID_A, true));

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toBeInstanceOf(WorkspaceUnregistered);
    const evt = publishedEvents[0] as WorkspaceUnregistered;
    expect(evt.purged).toBe(true);
  });

  it("idempotent for unregistered ids (no event, no throw)", async () => {
    await expect(
      sys.mediator.send(new UnregisterWorkspaceCommand(UUID_A, false)),
    ).resolves.toBeUndefined();
    await expect(
      sys.mediator.send(new UnregisterWorkspaceCommand(UUID_A, true)),
    ).resolves.toBeUndefined();
    expect(publishedEvents).toHaveLength(0);
  });
});

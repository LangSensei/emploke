import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "./_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

let scratch: string;
let sys: WorkspaceTestSubsystem;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-unregister-"));
  sys = await setupWorkspaceTestSubsystem();
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
  await rm(scratch, { recursive: true, force: true });
});

async function seedOnDisk(wsDir: string): Promise<void> {
  await sys.service.register({ id: UUID_A, workspaceDir: wsDir, name: "X" });
  await mkdir(path.join(wsDir, "sessions"), { recursive: true });
  await mkdir(path.join(wsDir, "tasks"), { recursive: true });
}

describe("WorkspaceService.unregister", () => {
  it("default (purge=false) removes only metadata; user files preserved", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await writeFile(path.join(wsDir, "user-file.txt"), "user data", "utf8");
    await writeFile(path.join(wsDir, "sessions", "trace.txt"), "agent file", "utf8");

    await sys.service.unregister({ id: UUID_A, purge: false });

    expect(await sys.service.getById(UUID_A)).toBeNull();
    expect((await stat(path.join(wsDir, "user-file.txt"))).isFile()).toBe(true);
    expect((await stat(path.join(wsDir, "sessions", "trace.txt"))).isFile()).toBe(true);
  });

  it("purge=true removes emploke subdirs but preserves workspaceDir + user files", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await writeFile(path.join(wsDir, "user-file.txt"), "user data", "utf8");

    await sys.service.unregister({ id: UUID_A, purge: true });

    await expect(stat(path.join(wsDir, "sessions"))).rejects.toThrow();
    await expect(stat(path.join(wsDir, "tasks"))).rejects.toThrow();
    expect((await stat(wsDir)).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "user-file.txt"))).isFile()).toBe(true);
  });

  it("idempotent for unregistered ids (no throw)", async () => {
    await expect(sys.service.unregister({ id: UUID_A, purge: false })).resolves.toBeUndefined();
    await expect(sys.service.unregister({ id: UUID_A, purge: true })).resolves.toBeUndefined();
  });

  it("purge defaults to false", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await sys.service.unregister({ id: UUID_A });
    expect((await stat(path.join(wsDir, "sessions"))).isDirectory()).toBe(true);
  });
});

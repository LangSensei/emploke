import "reflect-metadata";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnregisterWorkspaceCommand } from "../../../src/index.js";
import {
  Clock,
  UnregisterWorkspaceCommandHandler,
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
  WorkspaceRepository,
  WorkspaceUnregistered,
} from "../../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-05-20T12:00:00.000Z";

class FixedClock extends Clock {
  override nowIso(): string {
    return NOW;
  }
}

class InMemoryRepo extends WorkspaceRepository {
  readonly index = new Map<string, Workspace>();
  readonly deleted: string[] = [];

  override async list() {
    return [...this.index.values()];
  }
  override async findById(id: WorkspaceId) {
    return this.index.get(id.value) ?? null;
  }
  override async save(ws: Workspace) {
    this.index.set(ws.id.value, ws);
  }
  override async create(ws: Workspace) {
    this.index.set(ws.id.value, ws);
  }
  override async delete(id: WorkspaceId) {
    this.deleted.push(id.value);
    this.index.delete(id.value);
  }
  override async getCurrent() {
    return null;
  }
  override async setCurrent() {}
  override close() {}
}

let scratch: string;
let container: Container;
let mediator: Mediator;
let repo: InMemoryRepo;
let publishedEvents: unknown[];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-unregister-"));
  container = new Container();
  mediator = new Mediator();
  repo = new InMemoryRepo();
  container.bind(Mediator).toConstantValue(mediator);
  container.bind(WorkspaceRepository).toConstantValue(repo);
  container.bind(Clock).to(FixedClock).inSingletonScope();
  container.bind(UnregisterWorkspaceCommandHandler).toSelf();

  publishedEvents = [];
  vi.spyOn(mediator, "publish").mockImplementation(async (evt) => {
    publishedEvents.push(evt);
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function seedOnDisk(wsDir: string): Promise<Workspace> {
  await mkdir(path.join(wsDir, "sessions"), { recursive: true });
  await mkdir(path.join(wsDir, "tasks"), { recursive: true });
  const ws = Workspace.register({
    id: WorkspaceId.of(UUID_A),
    name: WorkspaceName.of("X"),
    workspaceDir: WorkspaceDir.of(wsDir),
    now: "2020-01-01T00:00:00.000Z",
  });
  ws.pullDomainEvents();
  repo.index.set(UUID_A, ws);
  return ws;
}

async function run(cmd: UnregisterWorkspaceCommand) {
  return container.get(UnregisterWorkspaceCommandHandler).handle(cmd);
}

describe("UnregisterWorkspaceCommandHandler", () => {
  it("default delete removes only metadata; user files preserved", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await writeFile(path.join(wsDir, "user-file.txt"), "user data", "utf8");
    await writeFile(path.join(wsDir, "sessions", "trace.txt"), "agent file", "utf8");

    await run(new UnregisterWorkspaceCommand(UUID_A, false));

    expect(repo.deleted).toEqual([UUID_A]);
    expect((await stat(path.join(wsDir, "user-file.txt"))).isFile()).toBe(true);
    expect((await stat(path.join(wsDir, "sessions", "trace.txt"))).isFile()).toBe(true);
  });

  it("purge=true removes emploke-owned subdirs but preserves workspaceDir + user files", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await writeFile(path.join(wsDir, "user-file.txt"), "user data", "utf8");
    await writeFile(path.join(wsDir, "sessions", "trace.txt"), "agent file", "utf8");

    await run(new UnregisterWorkspaceCommand(UUID_A, true));

    await expect(stat(path.join(wsDir, "sessions"))).rejects.toThrow();
    await expect(stat(path.join(wsDir, "tasks"))).rejects.toThrow();
    expect((await stat(wsDir)).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "user-file.txt"))).isFile()).toBe(true);
  });

  it("publishes WorkspaceUnregistered after the delete", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    await run(new UnregisterWorkspaceCommand(UUID_A, true));

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toBeInstanceOf(WorkspaceUnregistered);
    const evt = publishedEvents[0] as WorkspaceUnregistered;
    expect(evt.purged).toBe(true);
    expect(evt.unregisteredAt).toBe(NOW);
  });

  it("idempotent for unregistered ids (no event, no throw)", async () => {
    await expect(run(new UnregisterWorkspaceCommand(UUID_A, false))).resolves.toBeUndefined();
    await expect(run(new UnregisterWorkspaceCommand(UUID_A, true))).resolves.toBeUndefined();
    expect(publishedEvents).toHaveLength(0);
  });

  it("purges sandbox dirs BEFORE removing the registry entry (regression for the race)", async () => {
    const wsDir = path.join(scratch, "p");
    await seedOnDisk(wsDir);
    // The order is exercised implicitly: by the time delete() is
    // called, the subdirs are already gone. We assert by hooking
    // delete to observe the disk state at that moment.
    const observed: { sessionsExists: boolean } = { sessionsExists: true };
    const originalDelete = repo.delete.bind(repo);
    repo.delete = async (id) => {
      observed.sessionsExists = await stat(path.join(wsDir, "sessions"))
        .then((s) => s.isDirectory())
        .catch(() => false);
      return originalDelete(id);
    };

    await run(new UnregisterWorkspaceCommand(UUID_A, true));
    expect(observed.sessionsExists).toBe(false);
  });
});

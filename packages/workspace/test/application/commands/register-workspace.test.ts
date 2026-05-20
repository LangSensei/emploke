import "reflect-metadata";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RegisterWorkspaceCommand,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
  WorkspacePathConflictError,
} from "../../../src/index.js";
import {
  Clock,
  RegisterWorkspaceCommandHandler,
  type Workspace,
  WorkspaceRegistered,
  WorkspaceRepository,
} from "../../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const FIXED_NOW = "2026-05-20T12:00:00.000Z";

class FixedClock extends Clock {
  override nowIso(): string {
    return FIXED_NOW;
  }
}

class InMemoryWorkspaceRepository extends WorkspaceRepository {
  readonly created: Workspace[] = [];
  readonly saved: Workspace[] = [];
  readonly deleted: string[] = [];
  readonly currentValue: { id: string | null } = { id: null };
  /** Allows tests to seed initial state without going through create(). */
  readonly index = new Map<string, Workspace>();
  /** Allows tests to seed a path-conflict for create(). */
  readonly takenPaths = new Map<string, string>();
  /** Throw on create(). Set per-test. */
  createOverride: ((ws: Workspace) => Promise<void>) | null = null;

  override async list(): Promise<Workspace[]> {
    return [...this.index.values()];
  }

  override async findById(id: { value: string }): Promise<Workspace | null> {
    return this.index.get(id.value) ?? null;
  }

  override async save(ws: Workspace): Promise<void> {
    if (!this.index.has(ws.id.value)) {
      throw new Error(`save() called for unregistered id ${ws.id.value}`);
    }
    this.saved.push(ws);
    this.index.set(ws.id.value, ws);
  }

  override async create(ws: Workspace): Promise<void> {
    if (this.createOverride) {
      await this.createOverride(ws);
      return;
    }
    if (this.index.has(ws.id.value)) {
      throw new WorkspaceIdConflictError(ws.id.value);
    }
    const conflictingId = this.takenPaths.get(ws.workspaceDir.value);
    if (conflictingId) {
      throw new WorkspacePathConflictError(ws.workspaceDir.value, conflictingId);
    }
    this.created.push(ws);
    this.index.set(ws.id.value, ws);
  }

  override async delete(id: { value: string }): Promise<void> {
    this.deleted.push(id.value);
    this.index.delete(id.value);
    if (this.currentValue.id === id.value) this.currentValue.id = null;
  }

  override async getCurrent(): Promise<string | null> {
    return this.currentValue.id;
  }

  override async setCurrent(id: { value: string }): Promise<void> {
    this.currentValue.id = id.value;
  }

  override close(): void {}
}

let scratch: string;
let container: Container;
let mediator: Mediator;
let publishedEvents: unknown[];
let repo: InMemoryWorkspaceRepository;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-register-handler-"));

  container = new Container();
  mediator = new Mediator();
  container.bind(Mediator).toConstantValue(mediator);

  repo = new InMemoryWorkspaceRepository();
  container.bind(WorkspaceRepository).toConstantValue(repo);
  container.bind(Clock).to(FixedClock).inSingletonScope();
  container.bind(RegisterWorkspaceCommandHandler).toSelf();

  publishedEvents = [];
  vi.spyOn(mediator, "publish").mockImplementation(async (evt) => {
    publishedEvents.push(evt);
  });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runHandler(cmd: RegisterWorkspaceCommand) {
  const handler = container.get(RegisterWorkspaceCommandHandler);
  return handler.handle(cmd);
}

describe("RegisterWorkspaceCommandHandler", () => {
  it("creates workspaceDir + sessions/tasks subdirs and persists the workspace", async () => {
    const wsDir = path.join(scratch, "p");
    const result = await runHandler(new RegisterWorkspaceCommand(UUID_A, wsDir, "My Project"));
    expect(result.id).toBe(UUID_A);

    expect(repo.created).toHaveLength(1);
    expect(repo.created[0]!.id.value).toBe(UUID_A);
    expect(repo.created[0]!.name.value).toBe("My Project");
    expect(repo.created[0]!.workspaceDir.value).toBe(path.resolve(wsDir));
    expect(repo.created[0]!.createdAt).toBe(FIXED_NOW);

    // disk side effects
    expect((await stat(wsDir)).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "sessions"))).isDirectory()).toBe(true);
    expect((await stat(path.join(wsDir, "tasks"))).isDirectory()).toBe(true);
    // no catalog/ subdir created — catalog content lives in workspace.db
    await expect(stat(path.join(wsDir, "catalog"))).rejects.toThrow();
  });

  it("publishes WorkspaceRegistered after the write succeeds", async () => {
    const wsDir = path.join(scratch, "p");
    await runHandler(new RegisterWorkspaceCommand(UUID_A, wsDir, "Project"));

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toBeInstanceOf(WorkspaceRegistered);
    const evt = publishedEvents[0] as WorkspaceRegistered;
    expect(evt.id.value).toBe(UUID_A);
    expect(evt.registeredAt).toBe(FIXED_NOW);
  });

  it("does NOT publish when the repository's create throws", async () => {
    const wsDir = path.join(scratch, "p");
    repo.createOverride = async (ws) => {
      throw new WorkspaceIdConflictError(ws.id.value);
    };
    await expect(
      runHandler(new RegisterWorkspaceCommand(UUID_A, wsDir, "Project")),
    ).rejects.toBeInstanceOf(WorkspaceIdConflictError);
    expect(publishedEvents).toHaveLength(0);
  });

  it("rejects an invalid display name", async () => {
    await expect(
      runHandler(new RegisterWorkspaceCommand(UUID_A, path.join(scratch, "x"), "")),
    ).rejects.toBeInstanceOf(WorkspaceNameInvalidError);
    expect(repo.created).toHaveLength(0);
  });

  it("rejects a non-UUID id", async () => {
    await expect(
      runHandler(new RegisterWorkspaceCommand("not-a-uuid", path.join(scratch, "x"), "Project")),
    ).rejects.toBeInstanceOf(WorkspaceIdInvalidError);
    expect(repo.created).toHaveLength(0);
  });

  it("surfaces a path-conflict thrown by the repository", async () => {
    const wsDir = path.join(scratch, "shared");
    repo.takenPaths.set(path.resolve(wsDir), UUID_B);
    await expect(
      runHandler(new RegisterWorkspaceCommand(UUID_A, wsDir, "P")),
    ).rejects.toBeInstanceOf(WorkspacePathConflictError);
  });
});

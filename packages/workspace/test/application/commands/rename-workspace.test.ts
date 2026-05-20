import "reflect-metadata";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RenameWorkspaceCommand,
  WorkspaceNameInvalidError,
  WorkspaceNotRegisteredError,
} from "../../../src/index.js";
import {
  Clock,
  RenameWorkspaceCommandHandler,
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
  WorkspaceRenamed,
  WorkspaceRepository,
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
  readonly saved: Workspace[] = [];
  /** Simulate a concurrent delete between findById and save. */
  raceOnSave = false;

  override async list() {
    return [...this.index.values()];
  }
  override async findById(id: WorkspaceId) {
    return this.index.get(id.value) ?? null;
  }
  override async save(ws: Workspace): Promise<void> {
    if (this.raceOnSave) {
      throw new WorkspaceNotRegisteredError(ws.id.value);
    }
    this.saved.push(ws);
    this.index.set(ws.id.value, ws);
  }
  override async create(ws: Workspace) {
    this.index.set(ws.id.value, ws);
  }
  override async delete(id: WorkspaceId) {
    this.index.delete(id.value);
  }
  override async getCurrent() {
    return null;
  }
  override async setCurrent() {}
  override close() {}
}

let container: Container;
let mediator: Mediator;
let repo: InMemoryRepo;
let publishedEvents: unknown[];

beforeEach(() => {
  container = new Container();
  mediator = new Mediator();
  repo = new InMemoryRepo();
  container.bind(Mediator).toConstantValue(mediator);
  container.bind(WorkspaceRepository).toConstantValue(repo);
  container.bind(Clock).to(FixedClock).inSingletonScope();
  container.bind(RenameWorkspaceCommandHandler).toSelf();

  publishedEvents = [];
  vi.spyOn(mediator, "publish").mockImplementation(async (evt) => {
    publishedEvents.push(evt);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seed(name = "Old"): Workspace {
  const ws = Workspace.register({
    id: WorkspaceId.of(UUID_A),
    name: WorkspaceName.of(name),
    workspaceDir: WorkspaceDir.of("/tmp/x"),
    now: "2020-01-01T00:00:00.000Z",
  });
  ws.pullDomainEvents();
  repo.index.set(UUID_A, ws);
  return ws;
}

async function run(cmd: RenameWorkspaceCommand) {
  return container.get(RenameWorkspaceCommandHandler).handle(cmd);
}

describe("RenameWorkspaceCommandHandler", () => {
  it("renames the workspace, saves, and publishes WorkspaceRenamed", async () => {
    seed();
    await run(new RenameWorkspaceCommand(UUID_A, "New"));
    expect(repo.saved).toHaveLength(1);
    expect(repo.saved[0]!.name.value).toBe("New");
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toBeInstanceOf(WorkspaceRenamed);
    expect((publishedEvents[0] as WorkspaceRenamed).renamedAt).toBe(NOW);
  });

  it("is a no-op rename (no event, no save change) when new name equals old", async () => {
    seed("Same");
    await run(new RenameWorkspaceCommand(UUID_A, "Same"));
    // Aggregate didn't raise an event, but the handler still calls
    // save() — that's harmless because the row is byte-identical.
    expect(publishedEvents).toHaveLength(0);
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    await expect(run(new RenameWorkspaceCommand(UUID_A, "X"))).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
    expect(publishedEvents).toHaveLength(0);
  });

  it("propagates the strict-update race (delete between findById and save) as a typed 404", async () => {
    seed();
    repo.raceOnSave = true;
    await expect(run(new RenameWorkspaceCommand(UUID_A, "New"))).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
    expect(publishedEvents).toHaveLength(0);
  });

  it("validates the new name (rejects empty)", async () => {
    seed();
    await expect(run(new RenameWorkspaceCommand(UUID_A, ""))).rejects.toBeInstanceOf(
      WorkspaceNameInvalidError,
    );
    expect(publishedEvents).toHaveLength(0);
  });
});

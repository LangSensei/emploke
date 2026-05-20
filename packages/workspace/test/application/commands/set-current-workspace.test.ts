import "reflect-metadata";
import { Container } from "inversify";
import { beforeEach, describe, expect, it } from "vitest";
import { SetCurrentWorkspaceCommand, WorkspaceNotRegisteredError } from "../../../src/index.js";
import {
  SetCurrentWorkspaceCommandHandler,
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
  WorkspaceRepository,
} from "../../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

class InMemoryRepo extends WorkspaceRepository {
  readonly index = new Map<string, Workspace>();
  current: string | null = null;

  override async list() {
    return [...this.index.values()];
  }
  override async findById(id: WorkspaceId) {
    return this.index.get(id.value) ?? null;
  }
  override async save() {}
  override async create(ws: Workspace) {
    this.index.set(ws.id.value, ws);
  }
  override async delete(id: WorkspaceId) {
    this.index.delete(id.value);
  }
  override async getCurrent() {
    return this.current;
  }
  override async setCurrent(id: WorkspaceId) {
    if (!this.index.has(id.value)) {
      throw new WorkspaceNotRegisteredError(id.value);
    }
    this.current = id.value;
  }
  override close() {}
}

let container: Container;
let repo: InMemoryRepo;

beforeEach(() => {
  container = new Container();
  repo = new InMemoryRepo();
  container.bind(WorkspaceRepository).toConstantValue(repo);
  container.bind(SetCurrentWorkspaceCommandHandler).toSelf();
});

async function run(cmd: SetCurrentWorkspaceCommand) {
  return container.get(SetCurrentWorkspaceCommandHandler).handle(cmd);
}

describe("SetCurrentWorkspaceCommandHandler", () => {
  it("delegates to repo.setCurrent and updates current-workspace pointer", async () => {
    const ws = Workspace.register({
      id: WorkspaceId.of(UUID_A),
      name: WorkspaceName.of("X"),
      workspaceDir: WorkspaceDir.of("/tmp/x"),
      now: "2020-01-01T00:00:00.000Z",
    });
    ws.pullDomainEvents();
    repo.index.set(UUID_A, ws);

    await run(new SetCurrentWorkspaceCommand(UUID_A));
    expect(repo.current).toBe(UUID_A);
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    await expect(run(new SetCurrentWorkspaceCommand(UUID_A))).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
    expect(repo.current).toBeNull();
  });
});

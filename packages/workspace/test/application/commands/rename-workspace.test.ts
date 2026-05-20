import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegisterWorkspaceCommand,
  RenameWorkspaceCommand,
  WorkspaceNameInvalidError,
  WorkspaceNotRegisteredError,
} from "../../../src/index.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "../../_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

let sys: WorkspaceTestSubsystem;

beforeEach(async () => {
  sys = await setupWorkspaceTestSubsystem();
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
});

async function seed(name = "Old"): Promise<void> {
  await sys.mediator.send(new RegisterWorkspaceCommand(UUID_A, "/tmp/emploke-rename-test", name));
}

describe("RenameWorkspaceCommandHandler (Phase 2 / MikroORM)", () => {
  it("renames the workspace via the unit-of-work flush", async () => {
    await seed("Old");
    await sys.mediator.send(new RenameWorkspaceCommand(UUID_A, "New"));

    const view = await sys.queries.getById(UUID_A);
    expect(view?.name).toBe("New");
  });

  it("is a no-op rename when new name equals old", async () => {
    await seed("Same");
    await sys.mediator.send(new RenameWorkspaceCommand(UUID_A, "Same"));
    // Aggregate's `rename` short-circuits; UoW change-set is empty so
    // no UPDATE is issued.
    const view = await sys.queries.getById(UUID_A);
    expect(view?.name).toBe("Same");
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    await expect(sys.mediator.send(new RenameWorkspaceCommand(UUID_A, "X"))).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
  });

  it("validates the new name (rejects empty)", async () => {
    await seed();
    await expect(sys.mediator.send(new RenameWorkspaceCommand(UUID_A, ""))).rejects.toBeInstanceOf(
      WorkspaceNameInvalidError,
    );
  });
});

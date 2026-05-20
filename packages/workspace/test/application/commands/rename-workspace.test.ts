import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RegisterWorkspaceCommand,
  RenameWorkspaceCommand,
  WorkspaceNameInvalidError,
  WorkspaceNotRegisteredError,
} from "../../../src/index.js";
import { WorkspaceRenamed } from "../../../src/testing.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "../../_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

let sys: WorkspaceTestSubsystem;
let publishedEvents: unknown[];

beforeEach(async () => {
  sys = await setupWorkspaceTestSubsystem();
  publishedEvents = [];
  vi.spyOn(sys.mediator, "publish").mockImplementation(async (evt) => {
    publishedEvents.push(evt);
  });
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
  vi.restoreAllMocks();
});

async function seed(name = "Old"): Promise<void> {
  await sys.mediator.send(new RegisterWorkspaceCommand(UUID_A, "/tmp/emploke-rename-test", name));
  publishedEvents.length = 0; // drain the WorkspaceRegistered
}

describe("RenameWorkspaceCommandHandler (Phase 2 / MikroORM)", () => {
  it("renames the workspace and publishes WorkspaceRenamed via the unit-of-work flush", async () => {
    await seed("Old");
    await sys.mediator.send(new RenameWorkspaceCommand(UUID_A, "New"));

    const view = await sys.queries.getById(UUID_A);
    expect(view?.name).toBe("New");

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toBeInstanceOf(WorkspaceRenamed);
    const evt = publishedEvents[0] as WorkspaceRenamed;
    expect(evt.oldName.value).toBe("Old");
    expect(evt.newName.value).toBe("New");
  });

  it("is a no-op rename (no event, no write) when new name equals old", async () => {
    await seed("Same");
    await sys.mediator.send(new RenameWorkspaceCommand(UUID_A, "Same"));
    // Aggregate's `rename` short-circuits; no event raised; no
    // change-set; nothing for the subscriber to publish.
    expect(publishedEvents).toHaveLength(0);
    const view = await sys.queries.getById(UUID_A);
    expect(view?.name).toBe("Same");
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    await expect(sys.mediator.send(new RenameWorkspaceCommand(UUID_A, "X"))).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
    expect(publishedEvents).toHaveLength(0);
  });

  it("validates the new name (rejects empty)", async () => {
    await seed();
    await expect(sys.mediator.send(new RenameWorkspaceCommand(UUID_A, ""))).rejects.toBeInstanceOf(
      WorkspaceNameInvalidError,
    );
    expect(publishedEvents).toHaveLength(0);
  });
});

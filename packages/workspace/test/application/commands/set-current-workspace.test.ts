import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegisterWorkspaceCommand,
  SetCurrentWorkspaceCommand,
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

describe("SetCurrentWorkspaceCommandHandler (Phase 2 / MikroORM)", () => {
  it("updates the current-workspace pointer", async () => {
    await sys.mediator.send(new RegisterWorkspaceCommand(UUID_A, "/tmp/p", "X"));
    await sys.mediator.send(new SetCurrentWorkspaceCommand(UUID_A));
    expect(await sys.queries.getCurrentId()).toBe(UUID_A);
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    await expect(sys.mediator.send(new SetCurrentWorkspaceCommand(UUID_A))).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
    expect(await sys.queries.getCurrentId()).toBeNull();
  });
});

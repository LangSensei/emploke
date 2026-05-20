import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegisterWorkspaceCommand, WorkspaceQueries } from "../../src/index.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "../_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

let sys: WorkspaceTestSubsystem;

beforeEach(async () => {
  sys = await setupWorkspaceTestSubsystem();
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
});

describe("composeWorkspaceModule — end-to-end wiring (Phase 2)", () => {
  it("binds WorkspaceQueries and resolves a MikroWorkspaceQueries instance", async () => {
    const q = sys.container.get(WorkspaceQueries);
    expect(await q.list()).toEqual([]);
  });

  it("registers the RegisterWorkspaceCommand handler with the mediator", async () => {
    const result = await sys.mediator.send(
      new RegisterWorkspaceCommand(UUID_A, "/tmp/emploke-wiring-test", "End-To-End"),
    );
    expect(result.id).toBe(UUID_A);
    const view = await sys.queries.getById(UUID_A);
    expect(view?.name).toBe("End-To-End");
  });
});

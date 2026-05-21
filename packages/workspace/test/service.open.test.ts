import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceNotRegisteredError } from "../src/index.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "./_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let sys: WorkspaceTestSubsystem;

beforeEach(async () => {
  sys = await setupWorkspaceTestSubsystem();
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
});

describe("WorkspaceService.open", () => {
  it("registration sets lastOpenedAt so the freshly-registered workspace is current", async () => {
    await sys.service.register({ id: UUID_A, workspaceDir: "/tmp/a", name: "A" });
    expect(await sys.queries.getLastOpenedId()).toBe(UUID_A);
  });

  it("opening a workspace promotes it to most-recently-opened", async () => {
    await sys.service.register({ id: UUID_A, workspaceDir: "/tmp/a", name: "A" });
    await new Promise((r) => setTimeout(r, 5));
    await sys.service.register({ id: UUID_B, workspaceDir: "/tmp/b", name: "B" });
    expect(await sys.queries.getLastOpenedId()).toBe(UUID_B);

    await new Promise((r) => setTimeout(r, 5));
    await sys.service.open({ id: UUID_A });
    expect(await sys.queries.getLastOpenedId()).toBe(UUID_A);
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    await expect(sys.service.open({ id: UUID_A })).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
    expect(await sys.queries.getLastOpenedId()).toBeNull();
  });
});

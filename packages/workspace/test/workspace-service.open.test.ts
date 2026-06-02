import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceNotRegisteredError } from "../src/index.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "./_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let scratch: string;
let sys: WorkspaceTestSubsystem;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-open-"));
  sys = await setupWorkspaceTestSubsystem();
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
  await rm(scratch, { recursive: true, force: true });
});

describe("WorkspaceService.open", () => {
  it("registration sets lastOpenedAt so the freshly-registered workspace is current", async () => {
    await sys.service.register({ id: UUID_A, workspaceDir: path.join(scratch, "a"), name: "A" });
    expect(await sys.service.getLastOpenedId()).toBe(UUID_A);
  });

  it("opening a workspace promotes it to most-recently-opened", async () => {
    await sys.service.register({ id: UUID_A, workspaceDir: path.join(scratch, "a"), name: "A" });
    await new Promise((r) => setTimeout(r, 5));
    await sys.service.register({ id: UUID_B, workspaceDir: path.join(scratch, "b"), name: "B" });
    expect(await sys.service.getLastOpenedId()).toBe(UUID_B);

    await new Promise((r) => setTimeout(r, 5));
    await sys.service.open(UUID_A);
    expect(await sys.service.getLastOpenedId()).toBe(UUID_A);
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    await expect(sys.service.open(UUID_A)).rejects.toBeInstanceOf(WorkspaceNotRegisteredError);
    expect(await sys.service.getLastOpenedId()).toBeNull();
  });
});

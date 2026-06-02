import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceNameInvalidError, WorkspaceNotRegisteredError } from "../src/index.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "./_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

let scratch: string;
let sys: WorkspaceTestSubsystem;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-rename-"));
  sys = await setupWorkspaceTestSubsystem();
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
  await rm(scratch, { recursive: true, force: true });
});

async function seed(name = "Old"): Promise<void> {
  await sys.service.register({ id: UUID_A, workspaceDir: path.join(scratch, "p"), name });
}

describe("WorkspaceService.rename", () => {
  it("renames the workspace", async () => {
    await seed("Old");
    await sys.service.rename(UUID_A, { newName: "New" });
    expect((await sys.service.getById(UUID_A))?.name).toBe("New");
  });

  it("is a no-op rename when new name equals old", async () => {
    await seed("Same");
    await sys.service.rename(UUID_A, { newName: "Same" });
    expect((await sys.service.getById(UUID_A))?.name).toBe("Same");
  });

  it("throws WorkspaceNotRegisteredError for an unknown id", async () => {
    await expect(sys.service.rename(UUID_A, { newName: "X" })).rejects.toBeInstanceOf(
      WorkspaceNotRegisteredError,
    );
  });

  it("validates the new name (rejects empty)", async () => {
    await seed();
    await expect(sys.service.rename(UUID_A, { newName: "" })).rejects.toBeInstanceOf(
      WorkspaceNameInvalidError,
    );
  });
});

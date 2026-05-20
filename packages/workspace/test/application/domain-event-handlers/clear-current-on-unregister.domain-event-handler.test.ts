import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RegisterWorkspaceCommand,
  SetCurrentWorkspaceCommand,
  UnregisterWorkspaceCommand,
} from "../../../src/index.js";
import {
  setupWorkspaceTestSubsystem,
  teardownWorkspaceTestSubsystem,
  type WorkspaceTestSubsystem,
} from "../../_test-support.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let scratch: string;
let sys: WorkspaceTestSubsystem;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-clear-current-"));
  sys = await setupWorkspaceTestSubsystem();
});

afterEach(async () => {
  await teardownWorkspaceTestSubsystem(sys);
  await rm(scratch, { recursive: true, force: true });
});

// Integration tests for ClearCurrentOnUnregisterDomainEventHandler. The handler
// is wired automatically via composeWorkspaceModule; these tests use
// the real mediator (no publish mock) so the WorkspaceUnregistered
// event actually flows through the dispatcher → handler → em.remove
// path. They guard the value-equality check that motivated the
// switch from `nativeDelete` (with WHERE condition) to
// `findOne + value-check + em.remove`: without this check, a
// `getReference + remove` shortcut would clobber the pointer for
// any unregister, breaking the "non-current" case below.
describe("ClearCurrentOnUnregisterDomainEventHandler (Phase 2 / MikroORM)", () => {
  it("clears the pointer when the current workspace is unregistered", async () => {
    await sys.mediator.send(new RegisterWorkspaceCommand(UUID_A, path.join(scratch, "a"), "A"));
    await sys.mediator.send(new SetCurrentWorkspaceCommand(UUID_A));
    expect(await sys.queries.getCurrentId()).toBe(UUID_A);

    await sys.mediator.send(new UnregisterWorkspaceCommand(UUID_A, false));

    expect(await sys.queries.getCurrentId()).toBeNull();
  });

  it("leaves the pointer untouched when a non-current workspace is unregistered", async () => {
    await sys.mediator.send(new RegisterWorkspaceCommand(UUID_A, path.join(scratch, "a"), "A"));
    await sys.mediator.send(new RegisterWorkspaceCommand(UUID_B, path.join(scratch, "b"), "B"));
    await sys.mediator.send(new SetCurrentWorkspaceCommand(UUID_A));

    await sys.mediator.send(new UnregisterWorkspaceCommand(UUID_B, false));

    expect(await sys.queries.getCurrentId()).toBe(UUID_A);
  });

  it("is a no-op when no workspace is current and one is unregistered", async () => {
    await sys.mediator.send(new RegisterWorkspaceCommand(UUID_A, path.join(scratch, "a"), "A"));
    expect(await sys.queries.getCurrentId()).toBeNull();

    await sys.mediator.send(new UnregisterWorkspaceCommand(UUID_A, false));

    expect(await sys.queries.getCurrentId()).toBeNull();
  });
});

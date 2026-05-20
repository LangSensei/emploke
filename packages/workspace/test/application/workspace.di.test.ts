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

  // Pipeline ordering is enforced by import order in
  // packages/workspace/src/index.ts. ValidationBehavior must be
  // registered before TransactionBehavior so a failed validator
  // never opens a DB transaction. This test guards against an
  // accidental import auto-sort or refactor silently swapping the
  // two: the failure is loud and obvious in CI rather than a
  // subtle "transactions opened on bad input" runtime regression.
  it("registers LoggingBehavior outer to ValidationBehavior outer to TransactionBehavior", () => {
    const mappings = sys.mediator.pipelineBehaviors as unknown as {
      getAll(): { behaviorClass: { name: string } }[];
    };
    const order = mappings.getAll().map((m) => m.behaviorClass.name);
    // Outermost first. Logging wraps everything (so failed validations
    // still log); Validation wraps Transaction (so a rejected command
    // never opens em.transactional). The 3-element shape catches a
    // future import auto-sort that swaps any pair.
    expect(order).toEqual(["LoggingBehavior", "ValidationBehavior", "TransactionBehavior"]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowError,
  WorkflowKindRegistryFrozenError,
  WorkflowNodeKindAlreadyRegisteredError,
  WorkflowNodeKindNotRegisteredError,
} from "../src/errors.js";
import { workflowNodes, workflows } from "../src/schema.js";
import { WorkflowEntity, WorkflowNodeEntity } from "../src/workflow-entity.js";
import {
  fixedRandomUUID,
  makeStubHandler,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService kind registry", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({
      randomUUID: fixedRandomUUID(VALID_UUIDS),
      skipAutoRegister: true,
    });
  });

  afterEach(() => {
    h.close();
  });

  it("registerKind: rejects invalid kind names", () => {
    expect(() => h.service.registerKind("", makeStubHandler())).toThrow(WorkflowError);
    expect(() => h.service.registerKind("BadCaps", makeStubHandler())).toThrow(WorkflowError);
    expect(() => h.service.registerKind("9starts", makeStubHandler())).toThrow(WorkflowError);
    expect(() => h.service.registerKind("has space", makeStubHandler())).toThrow(WorkflowError);
  });

  it("registerKind: accepts valid kind names", () => {
    expect(() => h.service.registerKind("task", makeStubHandler())).not.toThrow();
    expect(() => h.service.registerKind("co-ord", makeStubHandler())).not.toThrow();
    expect(() => h.service.registerKind("foo_bar9", makeStubHandler())).not.toThrow();
  });

  it("registerKind: a second registration of the same kind throws WorkflowNodeKindAlreadyRegisteredError", () => {
    h.service.registerKind("task", makeStubHandler());
    expect(() => h.service.registerKind("task", makeStubHandler())).toThrow(
      WorkflowNodeKindAlreadyRegisteredError,
    );
  });

  it("recover: after recover, registerKind throws WorkflowKindRegistryFrozenError", async () => {
    h.service.registerKind("coordinator", makeStubHandler());
    h.service.registerKind("task", makeStubHandler());
    await h.service.recover();
    expect(() => h.service.registerKind("late", makeStubHandler())).toThrow(
      WorkflowKindRegistryFrozenError,
    );
  });

  it("recover: empty db returns silently and freezes the registry", async () => {
    h.service.registerKind("coordinator", makeStubHandler());
    h.service.registerKind("task", makeStubHandler());
    await expect(h.service.recover()).resolves.toBeUndefined();
    // Second call is a no-op; the registry stays frozen.
    await expect(h.service.recover()).resolves.toBeUndefined();
    expect(() => h.service.registerKind("late", makeStubHandler())).toThrow(
      WorkflowKindRegistryFrozenError,
    );
  });

  it("recover: orphan-kind row throws WorkflowNodeKindNotRegisteredError naming the kind", async () => {
    // Seed a workflow + a node whose `kind` is not registered.
    const now = "2026-06-07T00:00:00.000Z";
    h.db.db.transaction((tx) => {
      tx.insert(workflows)
        .values({
          id: VALID_UUIDS[0]!,
          brief: "x",
          details: null,
          status: "running",
          coordinatorAgent: "coord-a",
          createdAt: now,
          startedAt: now,
          endedAt: null,
        })
        .run();
      tx.insert(workflowNodes)
        .values({
          id: VALID_UUIDS[1]!,
          workflowId: VALID_UUIDS[0]!,
          kind: "orphan-kind",
          specJson: JSON.stringify({ agent: "a" }),
          status: "running",
          phase: 0,
          createdAt: now,
          readyAt: now,
          runningAt: now,
          endedAt: null,
        })
        .run();
    });
    h.service.registerKind("coordinator", makeStubHandler());
    h.service.registerKind("task", makeStubHandler());
    await expect(h.service.recover()).rejects.toBeInstanceOf(WorkflowNodeKindNotRegisteredError);
    // Registry is now frozen — register attempt after a failed recover
    // is rejected so the caller is forced to dispose + rebuild.
    expect(() => h.service.registerKind("orphan-kind", makeStubHandler())).toThrow(
      WorkflowKindRegistryFrozenError,
    );
  });

  it("recover: a second call after a successful first call is idempotent (no double preflight)", async () => {
    h.service.registerKind("coordinator", makeStubHandler());
    h.service.registerKind("task", makeStubHandler());
    await h.service.recover();
    // Seed an orphan row AFTER the first successful recover. A correct
    // implementation does NOT re-preflight on the second call, so this
    // does NOT throw.
    const now = "2026-06-07T00:00:00.000Z";
    h.db.db.transaction((tx) => {
      tx.insert(workflows)
        .values({
          id: VALID_UUIDS[0]!,
          brief: "x",
          details: null,
          status: "running",
          coordinatorAgent: "coord-a",
          createdAt: now,
          startedAt: now,
          endedAt: null,
        })
        .run();
      tx.insert(workflowNodes)
        .values({
          id: VALID_UUIDS[1]!,
          workflowId: VALID_UUIDS[0]!,
          kind: "orphan-kind",
          specJson: JSON.stringify({ agent: "a" }),
          status: "running",
          phase: 0,
          createdAt: now,
          readyAt: now,
          runningAt: now,
          endedAt: null,
        })
        .run();
    });
    await expect(h.service.recover()).resolves.toBeUndefined();
    expect(WorkflowEntity).toBeDefined();
    expect(WorkflowNodeEntity).toBeDefined();
  });
});

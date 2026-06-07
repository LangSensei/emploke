import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowMutationUnauthorizedError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
} from "../src/errors.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.cancelNode", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  it("cancels a task-kind node in `not_started`", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    expect((await h.service.getNode(nodeId)).status).toBe("not_started");
    await h.service.cancelNode({ callerCoordNodeId: initialCoordNodeId, nodeId });
    const n = await h.service.getNode(nodeId);
    expect(n.status).toBe("cancelled");
    expect(n.endedAt).toBeDefined();
    // No handler.cancel call for a not_started node — there's no
    // in-flight unit to abort.
    expect(h.taskHandler.cancelCalls).toEqual([]);
  });

  it("cancels a task-kind node in `running` and routes through handler.cancel post-commit", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [],
    });
    expect((await h.service.getNode(nodeId)).status).toBe("running");
    await h.service.cancelNode({ callerCoordNodeId: initialCoordNodeId, nodeId });
    const n = await h.service.getNode(nodeId);
    expect(n.status).toBe("cancelled");
    expect(h.taskHandler.cancelCalls).toEqual([nodeId]);
  });

  it("REJECTS coordinator-kind nodes (task-kind only)", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    // The coord is the caller; we try to cancel ANOTHER coord.
    const { nodeId: otherCoord } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "coordinator",
      spec: { agent: "coord-b" },
      parents: [initialCoordNodeId],
    });
    await expect(
      h.service.cancelNode({ callerCoordNodeId: initialCoordNodeId, nodeId: otherCoord }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotMutableError);
  });

  it("REJECTS already-terminal nodes (succeeded / failed / cancelled)", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: nodeId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.cancelNode({ callerCoordNodeId: initialCoordNodeId, nodeId }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotMutableError);
  });

  it("handler.cancel failure is logged but the substrate still marks the node cancelled", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [],
    });
    h.taskHandler.cancelShouldThrow = true;
    await h.service.cancelNode({ callerCoordNodeId: initialCoordNodeId, nodeId });
    const n = await h.service.getNode(nodeId);
    expect(n.status).toBe("cancelled");
    expect(h.taskHandler.cancelCalls).toEqual([nodeId]);
  });

  it("REJECTS when caller node belongs to a different workflow than the target node", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: localTask } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    const { initialCoordNodeId: otherCoord } = await h.service.createWorkflow({
      brief: "other",
      coordinatorAgent: "coord-z",
    });
    await expect(
      h.service.cancelNode({ callerCoordNodeId: otherCoord, nodeId: localTask }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
  });

  it("throws WorkflowNodeNotFoundError on a missing target node", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.cancelNode({
        callerCoordNodeId: initialCoordNodeId,
        nodeId: VALID_UUIDS[15]!,
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
  });
});

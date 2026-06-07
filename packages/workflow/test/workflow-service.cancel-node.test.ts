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

  it("cancels a worker-kind node in `not_started`", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    expect((await h.service.getNode(nodeId)).status).toBe("not_started");
    await h.service.cancelNode({ workflowId, nodeId });
    const n = await h.service.getNode(nodeId);
    expect(n.status).toBe("cancelled");
    expect(n.endedAt).toBeDefined();
    // No runner.cancel call for a not_started node — there's no
    // in-flight unit to abort.
    expect(h.workerRunner.cancelCalls).toEqual([]);
  });

  it("cancels a worker-kind node in `running` and routes through runner.cancel post-commit", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Materialise a parent task and force it terminal so the child
    // task lands in `running` via eager dispatch on insert.
    const { nodeId: parentTaskId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "p" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentTaskId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [parentTaskId],
    });
    expect((await h.service.getNode(nodeId)).status).toBe("running");
    await h.service.cancelNode({ workflowId, nodeId });
    const n = await h.service.getNode(nodeId);
    expect(n.status).toBe("cancelled");
    expect(h.workerRunner.cancelCalls).toEqual([nodeId]);
  });

  it("REJECTS coordinator-kind nodes (worker-kind only)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // The coord is the caller; we try to cancel ANOTHER coord.
    const { nodeId: otherCoord } = await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-b" },
      parents: [initialCoordNodeId],
    });
    await expect(h.service.cancelNode({ workflowId, nodeId: otherCoord })).rejects.toBeInstanceOf(
      WorkflowNodeNotMutableError,
    );
  });

  it("REJECTS already-terminal nodes (succeeded / failed / cancelled)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
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
    await expect(h.service.cancelNode({ workflowId, nodeId })).rejects.toBeInstanceOf(
      WorkflowNodeNotMutableError,
    );
  });

  it("runner.cancel failure is logged but the substrate still marks the node cancelled", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: parentTaskId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "p" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentTaskId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [parentTaskId],
    });
    h.workerRunner.cancelShouldThrow = true;
    await h.service.cancelNode({ workflowId, nodeId });
    const n = await h.service.getNode(nodeId);
    expect(n.status).toBe("cancelled");
    expect(h.workerRunner.cancelCalls).toEqual([nodeId]);
  });

  it("REJECTS when the target node belongs to a different workflow than `args.workflowId`", async () => {
    // R4: the caller is derived from `args.workflowId` (the
    // workflow's unique running coord); attempting to cancel a node
    // in workflow B from `workflowId=A` is rejected by the
    // cross-workflow check inside the cancelNode tx.
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Bootstrap a second workflow with its own task.
    const { workflowId: otherWfId, initialCoordNodeId: otherCoord } =
      await h.service.createWorkflow({
        brief: "other",
        coordinatorAgent: "coord-z",
      });
    const { nodeId: otherTask } = await h.service.addNode({
      workflowId: otherWfId,
      kind: "worker",
      spec: { agent: "w", brief: "remote" },
      parents: [otherCoord],
    });
    await expect(h.service.cancelNode({ workflowId, nodeId: otherTask })).rejects.toBeInstanceOf(
      WorkflowMutationUnauthorizedError,
    );
    void initialCoordNodeId;
  });

  it("throws WorkflowNodeNotFoundError on a missing target node", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.cancelNode({
        workflowId,
        nodeId: VALID_UUIDS[15]!,
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
  });
});

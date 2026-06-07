import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.dispatchAtomic", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  it("task: dispatches when ALL parents are succeeded", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    expect((await h.service.getNode(a)).status).toBe("not_started");
    // Mark the coord parent succeeded by hand; manual dispatchAtomic now
    // observes a satisfied predicate.
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    const before = h.workerRunner.dispatchCalls.length;
    await h.service.dispatchAtomic(a);
    expect((await h.service.getNode(a)).status).toBe("running");
    expect(h.workerRunner.dispatchCalls.length).toBe(before + 1);
  });

  it("task: does NOT dispatch when a parent is not yet succeeded", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    // Coord parent is still 'running' — predicate fails.
    const before = h.workerRunner.dispatchCalls.length;
    await h.service.dispatchAtomic(a);
    expect((await h.service.getNode(a)).status).toBe("not_started");
    expect(h.workerRunner.dispatchCalls.length).toBe(before);
  });

  it("coordinator: dispatches when ALL parents are terminal (succeeded OR failed OR cancelled)", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: parentTask } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    // childCoord must list its caller (initialCoord) as a parent.
    const { nodeId: childCoord } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "coordinator",
      spec: { agent: "coord-b" },
      parents: [initialCoordNodeId, parentTask],
    });
    // Mark both parents terminal: parentTask FAILED, initialCoord
    // SUCCEEDED. A worker-kind child would NOT dispatch (failed
    // parent) but a coord-kind child WILL.
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentTask,
        status: "failed",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    const before = h.coordRunner.dispatchCalls.length;
    await h.service.dispatchAtomic(childCoord);
    expect((await h.service.getNode(childCoord)).status).toBe("running");
    expect(h.coordRunner.dispatchCalls.length).toBe(before + 1);
  });

  it("silently no-ops when the node is already running", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const before = h.coordRunner.dispatchCalls.length;
    await h.service.dispatchAtomic(initialCoordNodeId);
    expect((await h.service.getNode(initialCoordNodeId)).status).toBe("running");
    expect(h.coordRunner.dispatchCalls.length).toBe(before);
  });

  it("silently no-ops when the workflow is already cancelled", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    await h.service.cancelWorkflow({ workflowId });
    // Cancel reconciliation already flipped the task. dispatchAtomic
    // is a no-op for terminal nodes.
    const before = h.workerRunner.dispatchCalls.length;
    await h.service.dispatchAtomic(nodeId);
    expect((await h.service.getNode(nodeId)).status).toBe("cancelled");
    expect(h.workerRunner.dispatchCalls.length).toBe(before);
  });

  it("on runner.dispatch throw, marks the node failed via a separate tx", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    // Materialise a parent task and force it terminal so the new
    // task's parent-readiness predicate fires eager dispatch on insert.
    const { nodeId: parentTaskId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
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
    h.workerRunner.dispatchShouldThrow = true;
    const { nodeId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [parentTaskId],
    });
    const n = await h.service.getNode(nodeId);
    expect(n.status).toBe("failed");
    expect(n.endedAt).toBeDefined();
  });

  it("eager dispatch reaction from addNode commits then dispatches once", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: parentTaskId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
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
    const before = h.workerRunner.dispatchCalls.length;
    const { nodeId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "worker",
      spec: { agent: "w", brief: "y" },
      parents: [parentTaskId],
    });
    expect((await h.service.getNode(nodeId)).status).toBe("running");
    expect(h.workerRunner.dispatchCalls.length).toBe(before + 1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowAlreadyTerminalError,
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

describe("WorkflowService.replaceNodeSpec", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  // ─── Happy paths ─────────────────────────────────────────

  it("swaps a worker spec and updates spec_json", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "v1" },
      parents: [initialCoordNodeId],
    });
    await h.service.replaceNodeSpec({
      workflowId,
      nodeId,
      newSpec: { agent: "w", brief: "v2", extra: "k" },
    });
    const node = await h.service.getNode(nodeId);
    expect(node.spec).toEqual({ agent: "w", brief: "v2", extra: "k" });
    expect(node.kind).toBe("worker");
    // workflow's coord agent denorm is unchanged.
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.coordinatorAgent).toBe("coord-agent");
  });

  it("swaps the LATEST coord spec and refreshes workflows.coordinator_agent", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: newCoord } = await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-v2" },
      parents: [initialCoordNodeId],
    });
    await h.service.replaceNodeSpec({
      workflowId,
      nodeId: newCoord,
      newSpec: { agent: "coord-v3", note: "updated" },
    });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.coordinatorAgent).toBe("coord-v3");
    const node = await h.service.getNode(newCoord);
    expect((node.spec as { agent: string }).agent).toBe("coord-v3");
  });

  it("does NOT refresh denorm when replacing an OLDER coord's spec", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // The bootstrap coord is running. Add coord-B as a child of the
    // bootstrap coord (legal because the bootstrap coord has no other
    // coord-direct-child yet). After insert, addNode flips the
    // workflows.coordinator_agent denorm to coord-B (the new latest).
    const { nodeId: coordB } = await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-B" },
      parents: [initialCoordNodeId],
    });
    expect((await h.service.getWorkflow(workflowId)).coordinatorAgent).toBe("coord-B");
    // Flip the bootstrap coord back to not_started so it is replaceable,
    // and promote coord-B to running so it becomes the new auth caller.
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "not_started",
        runningAt: null,
      });
      h.repo.updateNodeLifecycle(tx, {
        id: coordB,
        status: "running",
        runningAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await h.service.replaceNodeSpec({
      workflowId,
      nodeId: initialCoordNodeId,
      newSpec: { agent: "coord-OLDER-replaced" },
    });
    // Denorm should remain `coord-B` because coord-B is still the
    // latest coord by created_at.
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.coordinatorAgent).toBe("coord-B");
  });

  it("invokes runner.validate with the correct ctx and persists the returned spec", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "v1" },
      parents: [initialCoordNodeId],
    });
    h.workerRunner.validateCalls.length = 0;
    h.workerRunner.validateReturnValue = { agent: "w-canon", brief: "canonical" };
    await h.service.replaceNodeSpec({
      workflowId,
      nodeId,
      newSpec: { agent: "w", brief: "user-input" },
    });
    expect(h.workerRunner.validateCalls.length).toBe(1);
    const call = h.workerRunner.validateCalls[0]!;
    expect(call.spec).toEqual({ agent: "w", brief: "user-input" });
    expect(call.ctx.workflowId).toBe(workflowId);
    expect(call.ctx.workflowStatus).toBe("running");
    const node = await h.service.getNode(nodeId);
    expect(node.spec).toEqual({ agent: "w-canon", brief: "canonical" });
  });

  // ─── Sad paths ───────────────────────────────────────────

  it("REJECTS when runner.validate throws", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "v1" },
      parents: [initialCoordNodeId],
    });
    h.workerRunner.validateShouldThrow = new Error("bad spec");
    await expect(
      h.service.replaceNodeSpec({
        workflowId,
        nodeId,
        newSpec: { agent: "w", brief: "v2" },
      }),
    ).rejects.toThrow("bad spec");
    const node = await h.service.getNode(nodeId);
    expect(node.spec).toEqual({ agent: "w", brief: "v1" });
  });

  it("REJECTS when status != not_started", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "v1" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: nodeId,
        status: "running",
        runningAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.replaceNodeSpec({
        workflowId,
        nodeId,
        newSpec: { agent: "w", brief: "v2" },
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotMutableError);
  });

  it("throws WorkflowNodeNotFoundError on missing target", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.replaceNodeSpec({
        workflowId,
        nodeId: VALID_UUIDS[15]!,
        newSpec: { agent: "w" },
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
  });

  it("REJECTS cross-workflow target", async () => {
    const { workflowId } = await bootstrap(h);
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
    await expect(
      h.service.replaceNodeSpec({
        workflowId,
        nodeId: otherTask,
        newSpec: { agent: "w" },
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
  });

  it("REJECTS coord-kind spec missing `agent`", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: newCoord } = await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-v2" },
      parents: [initialCoordNodeId],
    });
    // Have validate return a shape WITHOUT `agent` — should trip
    // assertCoordinatorSpecAgent.
    h.coordRunner.validateReturnValue = { note: "missing agent" };
    await expect(
      h.service.replaceNodeSpec({
        workflowId,
        nodeId: newCoord,
        newSpec: { something: "else" },
      }),
    ).rejects.toThrow();
  });

  // ─── Workflow lifecycle gate ─────────────────────────────

  it("REJECTS when workflow is terminal", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "v1" },
      parents: [initialCoordNodeId],
    });
    await h.service.cancelWorkflow({ workflowId, cancellation: { kind: "user", message: "" } });
    await expect(
      h.service.replaceNodeSpec({
        workflowId,
        nodeId,
        newSpec: { agent: "w", brief: "v2" },
      }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyTerminalError);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowAlreadyTerminalError, WorkflowNotFoundError } from "../src/errors.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.cancelWorkflow", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  it("flips the workflow to cancelled and ends every non-terminal node", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: pending } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    // Materialise a parent task and force it terminal so the
    // `running` task lands in `running` via eager dispatch — needed
    // so the cancel reconciliation invokes handler.cancel for it.
    const { nodeId: parentTaskId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
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
    const { nodeId: running } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "y" },
      parents: [parentTaskId],
    });
    await h.service.cancelWorkflow({ workflowId });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.status).toBe("cancelled");
    // Every non-terminal node, INCLUDING the initial coord, is cancelled.
    const coord = await h.service.getNode(initialCoordNodeId);
    expect(coord.status).toBe("cancelled");
    expect((await h.service.getNode(pending)).status).toBe("cancelled");
    expect((await h.service.getNode(running)).status).toBe("cancelled");
    expect(h.taskHandler.cancelCalls).toContain(running);
  });

  it("CAS once-only: a second call throws WorkflowAlreadyTerminalError", async () => {
    const { workflowId } = await bootstrap(h);
    await h.service.cancelWorkflow({ workflowId });
    await expect(h.service.cancelWorkflow({ workflowId })).rejects.toBeInstanceOf(
      WorkflowAlreadyTerminalError,
    );
  });

  it("throws WorkflowNotFoundError on an unknown workflow", async () => {
    await expect(h.service.cancelWorkflow({ workflowId: VALID_UUIDS[15]! })).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });

  it("does NOT call handler.cancel for not_started / not-yet-running nodes", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: pending } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    expect((await h.service.getNode(pending)).status).toBe("not_started");
    await h.service.cancelWorkflow({ workflowId });
    // The pending task was cancelled by reconciliation but its
    // handler was never running — no abort call is needed.
    expect(h.taskHandler.cancelCalls).not.toContain(pending);
  });

  it("idempotent: succeeded → cancelWorkflow is rejected (workflow already terminal)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "succeeded" });
    await expect(h.service.cancelWorkflow({ workflowId })).rejects.toBeInstanceOf(
      WorkflowAlreadyTerminalError,
    );
  });
});

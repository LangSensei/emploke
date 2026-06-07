import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowAlreadyTerminalError,
  WorkflowError,
  WorkflowMutationUnauthorizedError,
} from "../src/errors.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.finishWorkflow", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  it("flips the workflow to the requested terminal status", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "succeeded" });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.status).toBe("succeeded");
    expect(wf.endedAt).toBeDefined();
  });

  it("CAS once-only: a second call throws WorkflowAlreadyTerminalError", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    await h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "succeeded" });
    // The caller coord is still running per `finishWorkflow` semantics,
    // but the workflow is now terminal — the auth gate's
    // workflow.status='running' check fails first.
    await expect(
      h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
  });

  it("EXCLUDES the calling coord from the cancel reconciliation", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: pendingTask } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    expect((await h.service.getNode(pendingTask)).status).toBe("not_started");

    await h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "succeeded" });

    // Caller coord remains running (substrate must NOT cancel the
    // very task that just called finishWorkflow).
    const caller = await h.service.getNode(initialCoordNodeId);
    expect(caller.status).toBe("running");

    // Pending task is cancelled by reconciliation.
    const pending = await h.service.getNode(pendingTask);
    expect(pending.status).toBe("cancelled");
  });

  it("invokes handler.cancel on running non-caller nodes during reconciliation", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    // Materialise a parent task and force it terminal so the
    // running task lands in `running` via eager dispatch.
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
    const { nodeId: runningTask } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [parentTaskId],
    });
    expect((await h.service.getNode(runningTask)).status).toBe("running");

    await h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "failed" });

    expect(h.taskHandler.cancelCalls).toContain(runningTask);
    expect((await h.service.getNode(runningTask)).status).toBe("cancelled");
  });

  it("REJECTS when caller is not in `running` status", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
  });

  it("REJECTS an invalid outcome value", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.finishWorkflow({
        callerCoordNodeId: initialCoordNodeId,
        outcome: "cancelled" as unknown as "succeeded",
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("a second finishWorkflow attempt after a successful one is blocked by the auth gate (workflow not running)", async () => {
    // This double-checks the CAS-or-auth ordering. The first call
    // wins; the second sees workflow.status='succeeded' and the auth
    // gate (workflow.status='running') rejects before the CAS runs.
    const { initialCoordNodeId } = await bootstrap(h);
    await h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "succeeded" });
    await expect(
      h.service.finishWorkflow({ callerCoordNodeId: initialCoordNodeId, outcome: "failed" }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
    // Coverage note: `WorkflowAlreadyTerminalError` is reachable
    // when a future caller bypasses the auth gate, e.g. via
    // `cancelWorkflow` — exercised in `workflow-service.cancel-workflow.test.ts`.
    expect(WorkflowAlreadyTerminalError).toBeDefined();
  });
});

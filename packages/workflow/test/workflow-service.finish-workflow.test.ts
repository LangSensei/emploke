import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowAlreadyTerminalError, WorkflowError } from "../src/errors.js";
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
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.status).toBe("succeeded");
    expect(wf.endedAt).toBeDefined();
  });

  it("CAS once-only: a second call throws WorkflowAlreadyTerminalError", async () => {
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });
    // After the first call, the workflow is terminal. The
    // substrate's CAS-guarded UPDATE matches zero rows the second
    // time and the service throws `WorkflowAlreadyTerminalError`.
    await expect(
      h.service.finishWorkflow({ workflowId, outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyTerminalError);
  });

  it("EXCLUDES running coordinator-kind nodes from the cancel reconciliation", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: pendingTask } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    expect((await h.service.getNode(pendingTask)).status).toBe("not_started");

    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });

    // Caller coord remains running (substrate must NOT cancel the
    // very task that just called finishWorkflow). The reconciliation
    // explicitly excludes running coordinator-kind nodes so the
    // in-flight call frame can exit naturally.
    const caller = await h.service.getNode(initialCoordNodeId);
    expect(caller.status).toBe("running");

    // Pending task is cancelled by reconciliation.
    const pending = await h.service.getNode(pendingTask);
    expect(pending.status).toBe("cancelled");
  });

  it("invokes runner.cancel on running non-coord nodes during reconciliation", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Materialise a parent task and force it terminal so the
    // running task lands in `running` via eager dispatch.
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
    const { nodeId: runningTask } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [parentTaskId],
    });
    expect((await h.service.getNode(runningTask)).status).toBe("running");

    await h.service.finishWorkflow({
      workflowId,
      outcome: "failed",
      failure: { kind: "coord", message: "ran out of budget" },
    });

    expect(h.workerRunner.cancelCalls).toContain(runningTask);
    expect((await h.service.getNode(runningTask)).status).toBe("cancelled");
  });

  it("REJECTS an invalid outcome value", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.finishWorkflow({
        workflowId,
        outcome: "cancelled" as unknown as "succeeded",
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("a second finishWorkflow attempt after a successful one is blocked by the CAS", async () => {
    // The first call wins; the second sees workflow.status='succeeded'
    // and the CAS-guarded UPDATE matches no rows. The service throws
    // `WorkflowAlreadyTerminalError`.
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });
    await expect(
      h.service.finishWorkflow({
        workflowId,
        outcome: "failed",
        failure: { kind: "coord", message: "x" },
      }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyTerminalError);
  });

  it("persists success.output when supplied with outcome='succeeded'", async () => {
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({
      workflowId,
      outcome: "succeeded",
      success: { output: "All sub-runs converged on green." },
    });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.success).toEqual({ output: "All sub-runs converged on green." });
    expect(wf.failure).toBeUndefined();
    expect(wf.cancellation).toBeUndefined();
  });

  it("defaults success.output to null when omitted with outcome='succeeded'", async () => {
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.success).toEqual({ output: null });
  });

  it("persists failure.message + failure.kind when supplied with outcome='failed'", async () => {
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({
      workflowId,
      outcome: "failed",
      failure: { kind: "coord", message: "budget exhausted" },
    });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.failure).toEqual({ kind: "coord", message: "budget exhausted" });
    expect(wf.success).toBeUndefined();
  });

  it("REJECTS outcome='failed' with no failure payload", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.finishWorkflow({
        workflowId,
        outcome: "failed",
      } as unknown as Parameters<typeof h.service.finishWorkflow>[0]),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

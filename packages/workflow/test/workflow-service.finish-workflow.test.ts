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
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.status).toBe("succeeded");
    expect(wf.endedAt).toBeDefined();
  });

  it("CAS once-only: a second call throws WorkflowMutationUnauthorizedError", async () => {
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });
    // After the first call, the workflow is terminal. R4: deriving
    // the caller from `workflowId` reads no running coords and the
    // derivation rejects with WorkflowMutationUnauthorizedError
    // before the CAS would run.
    await expect(
      h.service.finishWorkflow({ workflowId, outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
  });

  it("EXCLUDES the calling coord from the cancel reconciliation", async () => {
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
    // very task that just called finishWorkflow). R4: this exercises
    // the C.id-held-across-CAS path — if we re-derived after the CAS
    // flip, we'd see 0 running coords and exclusion would degrade.
    const caller = await h.service.getNode(initialCoordNodeId);
    expect(caller.status).toBe("running");

    // Pending task is cancelled by reconciliation.
    const pending = await h.service.getNode(pendingTask);
    expect(pending.status).toBe("cancelled");
  });

  it("invokes runner.cancel on running non-caller nodes during reconciliation", async () => {
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

    await h.service.finishWorkflow({ workflowId, outcome: "failed" });

    expect(h.workerRunner.cancelCalls).toContain(runningTask);
    expect((await h.service.getNode(runningTask)).status).toBe("cancelled");
  });

  it("REJECTS when there is no running coord (handover window)", async () => {
    // R4: the only coord is the initial one. Terminating it
    // simulates a handover window with no running coord; derivation
    // returns 0 rows and rejects with WorkflowMutationUnauthorizedError.
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.finishWorkflow({ workflowId, outcome: "succeeded" }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
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

  it("a second finishWorkflow attempt after a successful one is blocked by the derivation gate (workflow terminal)", async () => {
    // This double-checks the derive-before-CAS ordering. The first
    // call wins; the second sees workflow.status='succeeded' inside
    // `deriveCallerCoord` and rejects before the CAS runs.
    const { workflowId } = await bootstrap(h);
    await h.service.finishWorkflow({ workflowId, outcome: "succeeded" });
    await expect(
      h.service.finishWorkflow({ workflowId, outcome: "failed" }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
    // Coverage note: `WorkflowAlreadyTerminalError` is reachable
    // when a future caller bypasses the auth gate, e.g. via
    // `cancelWorkflow` — exercised in `workflow-service.cancel-workflow.test.ts`.
    expect(WorkflowAlreadyTerminalError).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowError, WorkflowNodeKindUnknownError } from "../src/errors.js";
import {
  fixedRandomUUID,
  makeStubHandler,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.createWorkflow", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  it("creates workflow + initial coord node + denormalized coordinator_agent in one atomic boundary", async () => {
    const { workflowId, initialCoordNodeId } = await h.service.createWorkflow({
      brief: "do the thing",
      coordinatorAgent: "coord-a",
    });
    expect(workflowId).toBe(VALID_UUIDS[0]);
    expect(initialCoordNodeId).toBe(VALID_UUIDS[1]);

    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.brief).toBe("do the thing");
    expect(wf.status).toBe("running");
    expect(wf.coordinatorAgent).toBe("coord-a");

    const coord = await h.service.getNode(initialCoordNodeId);
    expect(coord.kind).toBe("coordinator");
    expect(coord.phase).toBe(0);
    expect(coord.spec).toEqual({ agent: "coord-a" });
  });

  it("denorm invariant: `workflows.coordinator_agent` matches the last-inserted coord node's spec.agent", async () => {
    const { workflowId } = await h.service.createWorkflow({
      brief: "x",
      coordinatorAgent: "coord-a",
    });
    const wf = await h.service.getWorkflow(workflowId);
    const nodes = await h.repo.listNodesByWorkflow(workflowId);
    // The "last" coord is defined by createdAt DESC, id DESC; we
    // only have one coord at this point, so the rule is trivial —
    // the assertion is "the cached value tracks the only coord".
    const coords = nodes.filter((n) => n.kind === "coordinator");
    expect(coords).toHaveLength(1);
    expect(wf.coordinatorAgent).toBe((coords[0]?.spec as { agent: string }).agent);
  });

  it("dispatch trigger: invokes the coordinator handler.dispatch with the resolved nodeDir", async () => {
    const { workflowId, initialCoordNodeId } = await h.service.createWorkflow({
      brief: "x",
      coordinatorAgent: "coord-a",
    });
    expect(h.coordHandler.dispatchCalls).toHaveLength(1);
    const call = h.coordHandler.dispatchCalls[0]!;
    expect(call.workflowId).toBe(workflowId);
    expect(call.nodeId).toBe(initialCoordNodeId);
    expect(call.spec).toEqual({ agent: "coord-a" });
    expect(call.nodeDir).toContain(initialCoordNodeId);
    // After dispatch, the coord node is `running`.
    const coord = await h.service.getNode(initialCoordNodeId);
    expect(coord.status).toBe("running");
  });

  it("validate ctx: routes the initial coord through handler.validate with self-bootstrap identity", async () => {
    h.coordHandler.validateReturnValue = { agent: "coord-a", validated: true };
    const { initialCoordNodeId, workflowId } = await h.service.createWorkflow({
      brief: "x",
      coordinatorAgent: "coord-a",
    });
    expect(h.coordHandler.validateCalls).toHaveLength(1);
    const v = h.coordHandler.validateCalls[0]!;
    expect(v.spec).toEqual({ agent: "coord-a" });
    expect(v.ctx.callerCoordNodeId).toBe(initialCoordNodeId);
    expect(v.ctx.workflowId).toBe(workflowId);
    expect(v.ctx.callerCoordSpec).toEqual({ agent: "coord-a" });
    expect(v.ctx.workflowStatus).toBe("running");
    // The persisted spec is what the handler returned.
    const coord = await h.service.getNode(initialCoordNodeId);
    expect(coord.spec).toEqual({ agent: "coord-a", validated: true });
  });

  it("rejects an empty brief", async () => {
    await expect(
      h.service.createWorkflow({ brief: "   ", coordinatorAgent: "x" }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("rejects an empty coordinatorAgent", async () => {
    await expect(
      h.service.createWorkflow({ brief: "x", coordinatorAgent: "" }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("throws WorkflowNodeKindUnknownError when the coordinator kind has no handler", async () => {
    const h2 = makeWorkflowTestHandle({
      randomUUID: fixedRandomUUID(VALID_UUIDS),
      skipAutoRegister: true,
    });
    try {
      h2.service.registerKind("task", makeStubHandler());
      await expect(
        h2.service.createWorkflow({ brief: "x", coordinatorAgent: "coord-a" }),
      ).rejects.toBeInstanceOf(WorkflowNodeKindUnknownError);
    } finally {
      h2.close();
    }
  });

  it("dispatch-failure inside createWorkflow flips initial coord to failed", async () => {
    h.coordHandler.dispatchShouldThrow = true;
    const { initialCoordNodeId } = await h.service.createWorkflow({
      brief: "x",
      coordinatorAgent: "coord-a",
    });
    const coord = await h.service.getNode(initialCoordNodeId);
    expect(coord.status).toBe("failed");
    expect(coord.endedAt).toBeDefined();
  });
});

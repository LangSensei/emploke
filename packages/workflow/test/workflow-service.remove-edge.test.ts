import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowEdgeNotFoundError,
  WorkflowMutationUnauthorizedError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
  WorkflowNotFoundError,
  WorkflowRemoveEdgeOrphansChildError,
} from "../src/errors.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.removeEdge", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  // ─── Happy paths ─────────────────────────────────────────

  it("removes a redundant edge between two existing nodes", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId, a],
    });
    expect((await h.service.getNode(b)).phase).toBe(2);
    await h.service.removeEdge({ workflowId, fromNodeId: a, toNodeId: b });
    const dag = await h.service.getDag(workflowId);
    expect(dag.edges.some((e) => e.from === a && e.to === b)).toBe(false);
    // After removing the a→b edge, b's parents = [initialCoordNode]
    // only, so phase shrinks to coord.phase + 1 = 1.
    expect((await h.service.getNode(b)).phase).toBe(1);
  });

  it("no-op recompute: removing a non-longest-path edge leaves phases unchanged", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [a],
    });
    const { nodeId: c } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "c" },
      parents: [initialCoordNodeId, b],
    });
    // c has parents [coord (phase 0), b (phase 2)] so c.phase = 3.
    expect((await h.service.getNode(c)).phase).toBe(3);
    // Remove coord→c (the shorter path). c retains b as a parent
    // and phase remains 3.
    await h.service.removeEdge({
      workflowId,
      fromNodeId: initialCoordNodeId,
      toNodeId: c,
    });
    expect((await h.service.getNode(c)).phase).toBe(3);
  });

  // ─── Sad paths ───────────────────────────────────────────

  it("REJECTS when to-node status != not_started", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId, a],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: b,
        status: "running",
        runningAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.removeEdge({ workflowId, fromNodeId: a, toNodeId: b }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotMutableError);
  });

  it("REJECTS when to-node would lose its last parent", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: child } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "child" },
      parents: [initialCoordNodeId],
    });
    await expect(
      h.service.removeEdge({
        workflowId,
        fromNodeId: initialCoordNodeId,
        toNodeId: child,
      }),
    ).rejects.toBeInstanceOf(WorkflowRemoveEdgeOrphansChildError);
  });

  it("throws WorkflowEdgeNotFoundError when the edge does not exist", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId],
    });
    // No a→b edge exists.
    await expect(
      h.service.removeEdge({ workflowId, fromNodeId: a, toNodeId: b }),
    ).rejects.toBeInstanceOf(WorkflowEdgeNotFoundError);
  });

  it("throws WorkflowNodeNotFoundError when endpoints are missing", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.removeEdge({
        workflowId,
        fromNodeId: VALID_UUIDS[14]!,
        toNodeId: VALID_UUIDS[15]!,
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
  });

  it("REJECTS cross-workflow endpoints", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
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
      h.service.removeEdge({
        workflowId,
        fromNodeId: initialCoordNodeId,
        toNodeId: otherTask,
      }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
  });

  // ─── Auth gate ───────────────────────────────────────────

  it("REJECTS when workflowId does not exist", async () => {
    await bootstrap(h);
    await expect(
      h.service.removeEdge({
        workflowId: VALID_UUIDS[15]!,
        fromNodeId: VALID_UUIDS[13]!,
        toNodeId: VALID_UUIDS[14]!,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("REJECTS when no coord is running", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId, a],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.removeEdge({ workflowId, fromNodeId: a, toNodeId: b }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
  });

  it("REJECTS when workflow is terminal", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId, a],
    });
    await h.service.cancelWorkflow({ workflowId });
    await expect(
      h.service.removeEdge({ workflowId, fromNodeId: a, toNodeId: b }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
  });

  it("REJECTS when 2+ coords are running (invariant #2)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId, a],
    });
    const { nodeId: extraCoord } = await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-extra" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: extraCoord,
        status: "running",
        runningAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.removeEdge({ workflowId, fromNodeId: a, toNodeId: b }),
    ).rejects.toBeInstanceOf(WorkflowMutationUnauthorizedError);
  });
});

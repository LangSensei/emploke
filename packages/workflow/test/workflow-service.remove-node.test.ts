import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowMutationUnauthorizedError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
  WorkflowNotFoundError,
  WorkflowRemoveNodeOrphansChildError,
} from "../src/errors.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.removeNode", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  // ─── Happy paths ─────────────────────────────────────────

  it("removes a leaf worker-kind node and clears its adjacency", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: leaf } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "leaf" },
      parents: [initialCoordNodeId],
    });
    await h.service.removeNode({ workflowId, nodeId: leaf });
    await expect(h.service.getNode(leaf)).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
    const dag = await h.service.getDag(workflowId);
    expect(dag.nodes.map((n) => n.id)).not.toContain(leaf);
    expect(dag.edges.some((e) => e.from === leaf || e.to === leaf)).toBe(false);
  });

  it("removes a middle-of-chain node and decreases descendant phase by 1", async () => {
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
      parents: [b],
    });
    // Need to preserve b having a parent after a's removal: attach
    // b to coord too. Then remove a; b loses one parent (a), keeps
    // coord; c is downstream of b so its phase should shrink.
    await h.service.addEdge({ workflowId, fromNodeId: initialCoordNodeId, toNodeId: b });
    expect((await h.service.getNode(b)).phase).toBe(2);
    expect((await h.service.getNode(c)).phase).toBe(3);
    await h.service.removeNode({ workflowId, nodeId: a });
    expect((await h.service.getNode(b)).phase).toBe(1);
    expect((await h.service.getNode(c)).phase).toBe(2);
  });

  it("removes all adjacent edges (incoming + outgoing) in the same tx", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: middle } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "m" },
      parents: [initialCoordNodeId, a],
    });
    const { nodeId: child } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "c" },
      parents: [middle, a],
    });
    // child has two parents (middle + a). After removing middle,
    // child should retain `a` as a parent and no edges should refer
    // to middle.
    await h.service.removeNode({ workflowId, nodeId: middle });
    const dag = await h.service.getDag(workflowId);
    expect(dag.edges.some((e) => e.from === middle || e.to === middle)).toBe(false);
    const childAfter = await h.service.getNode(child);
    expect(childAfter.id).toBe(child);
  });

  // ─── Sad paths ───────────────────────────────────────────

  it("REJECTS when status is not `not_started`", async () => {
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
    await expect(h.service.removeNode({ workflowId, nodeId })).rejects.toBeInstanceOf(
      WorkflowNodeNotMutableError,
    );
  });

  it("REJECTS when removal would orphan a child", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: parent } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "p" },
      parents: [initialCoordNodeId],
    });
    await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "child" },
      parents: [parent],
    });
    await expect(h.service.removeNode({ workflowId, nodeId: parent })).rejects.toBeInstanceOf(
      WorkflowRemoveNodeOrphansChildError,
    );
  });

  it("throws WorkflowNodeNotFoundError on a missing target node", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.removeNode({ workflowId, nodeId: VALID_UUIDS[15]! }),
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
    await expect(h.service.removeNode({ workflowId, nodeId: otherTask })).rejects.toBeInstanceOf(
      WorkflowMutationUnauthorizedError,
    );
  });

  // ─── Auth gate ───────────────────────────────────────────

  it("REJECTS when workflowId does not exist", async () => {
    await bootstrap(h);
    await expect(
      h.service.removeNode({
        workflowId: VALID_UUIDS[15]!,
        nodeId: VALID_UUIDS[14]!,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("REJECTS when no coord is running (handover window)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(h.service.removeNode({ workflowId, nodeId })).rejects.toBeInstanceOf(
      WorkflowMutationUnauthorizedError,
    );
  });

  it("REJECTS when workflow is terminal (cancel race)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    await h.service.cancelWorkflow({ workflowId });
    await expect(h.service.removeNode({ workflowId, nodeId })).rejects.toBeInstanceOf(
      WorkflowMutationUnauthorizedError,
    );
  });

  it("REJECTS when 2+ coords are running (invariant #2)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: leaf } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
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
    await expect(h.service.removeNode({ workflowId, nodeId: leaf })).rejects.toBeInstanceOf(
      WorkflowMutationUnauthorizedError,
    );
  });
});

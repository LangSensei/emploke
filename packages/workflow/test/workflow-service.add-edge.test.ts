import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ParentStateError,
  WorkflowEdgeCycleError,
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

describe("WorkflowService.addEdge", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  it("inserts the edge and reports the to-node's new phase", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    // Two parallel root-ish tasks; then connect them with an edge.
    const { nodeId: a } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId],
    });
    // Initial phases: a=1, b=1.
    const before = await h.service.getNode(b);
    expect(before.phase).toBe(1);
    const { toPhase } = await h.service.addEdge({
      callerCoordNodeId: initialCoordNodeId,
      fromNodeId: a,
      toNodeId: b,
    });
    expect(toPhase).toBe(2);
    const after = await h.service.getNode(b);
    expect(after.phase).toBe(2);
  });

  it("REJECTS when the to-node is not `not_started`", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId],
    });
    // Force b into 'running' so the addEdge guard fires.
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: b,
        status: "running",
        runningAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.addEdge({
        callerCoordNodeId: initialCoordNodeId,
        fromNodeId: a,
        toNodeId: b,
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotMutableError);
  });

  it("REJECTS when adding the edge would close a cycle", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "b" },
      parents: [a],
    });
    // The edge b → a would close coord→a→b→a.
    await expect(
      h.service.addEdge({
        callerCoordNodeId: initialCoordNodeId,
        fromNodeId: b,
        toNodeId: a,
      }),
    ).rejects.toBeInstanceOf(WorkflowEdgeCycleError);
  });

  it("REJECTS task-kind to-node when the from-node is failed/cancelled", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "b" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: a,
        status: "failed",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.addEdge({
        callerCoordNodeId: initialCoordNodeId,
        fromNodeId: a,
        toNodeId: b,
      }),
    ).rejects.toBeInstanceOf(ParentStateError);
  });

  it("phase recompute does NOT touch running / terminal descendants", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    // Build A (phase 1), B (phase 2 child of A), C (phase 1, root).
    const { nodeId: a } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "b" },
      parents: [a],
    });
    const { nodeId: c } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "c" },
      parents: [initialCoordNodeId],
    });
    // Force B into running and pin its phase as a sealed value the
    // recompute MUST NOT alter.
    const bBefore = await h.service.getNode(b);
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: b,
        status: "running",
        runningAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await h.service.addEdge({
      callerCoordNodeId: initialCoordNodeId,
      fromNodeId: c,
      toNodeId: a,
    });
    // A's phase should now be max(coord.phase=0, c.phase=1) + 1 = 2.
    const aAfter = await h.service.getNode(a);
    expect(aAfter.phase).toBe(2);
    // B was running — its phase MUST be the pre-recompute value.
    const bAfter = await h.service.getNode(b);
    expect(bAfter.phase).toBe(bBefore.phase);
  });

  it("phase recompute cascades through the not_started subtree", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: a } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: b } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "b" },
      parents: [a],
    });
    const { nodeId: c } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "c" },
      parents: [initialCoordNodeId],
    });
    // Add edge c → a, recomputing a (and cascading to b).
    await h.service.addEdge({
      callerCoordNodeId: initialCoordNodeId,
      fromNodeId: c,
      toNodeId: a,
    });
    const aAfter = await h.service.getNode(a);
    const bAfter = await h.service.getNode(b);
    expect(aAfter.phase).toBe(2);
    expect(bAfter.phase).toBe(3);
  });

  it("REJECTS when endpoints are in different workflows", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    const { nodeId: localTask } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    const { initialCoordNodeId: otherCoord } = await h.service.createWorkflow({
      brief: "y",
      coordinatorAgent: "coord-z",
    });
    await expect(
      h.service.addEdge({
        callerCoordNodeId: initialCoordNodeId,
        fromNodeId: localTask,
        toNodeId: otherCoord,
      }),
    ).rejects.toBeDefined();
  });

  it("REJECTS when from-node or to-node is missing", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.addEdge({
        callerCoordNodeId: initialCoordNodeId,
        fromNodeId: VALID_UUIDS[14]!,
        toNodeId: VALID_UUIDS[15]!,
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
  });

  it("eager dispatch reaction: fires `dispatchAtomic` on the to-node when its parents are now ready", async () => {
    const { initialCoordNodeId } = await bootstrap(h);
    // Two parallel tasks; mark one already-succeeded.
    const { nodeId: parentA } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "a" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentA,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    // Child task created with no parents — eager-dispatch fires
    // immediately (root rule). Reset dispatch calls so we can
    // isolate the addEdge eager-dispatch reaction.
    const { nodeId: child } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "w", brief: "c" },
      parents: [parentA],
    });
    expect((await h.service.getNode(child)).status).toBe("running");
  });
});

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

  it("recomputes phases convergently when removal yields multi-seed overlapping subtrees (P15-g)", async () => {
    // P15-g: BFS convergence for multi-seed `recomputePhasesInTx`.
    // `addEdge` has a 1-seed test already; `removeNode` of a parent
    // with 2+ children is the canonical multi-seed trigger and the
    // overlap between the seeds (shared descendant subtree) is what
    // stresses the convergence path.
    const { workflowId, initialCoordNodeId: coord } = await bootstrap(h);
    // Shape:
    //   coord ──→ M ──→ A ──→ D
    //         │       \ /    ↑
    //         │        X     │
    //         │       / \    │
    //         └──→ B ──→ E ──┘  (D and E both have parents {A, B})
    //
    // Phases pre-removal: coord=0, M=1, A=2, B=2, D=3, E=3.
    const { nodeId: m } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "m" },
      parents: [coord],
    });
    const { nodeId: a } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "a" },
      parents: [coord, m],
    });
    const { nodeId: b } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "b" },
      parents: [coord, m],
    });
    const { nodeId: d } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "d" },
      parents: [a, b],
    });
    const { nodeId: e } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "e" },
      parents: [a, b],
    });
    expect((await h.service.getNode(a)).phase).toBe(2);
    expect((await h.service.getNode(b)).phase).toBe(2);
    expect((await h.service.getNode(d)).phase).toBe(3);
    expect((await h.service.getNode(e)).phase).toBe(3);

    // Remove M. Seeds = {A, B}; both lost their M-edge. {D, E} are
    // the overlapping descendant subtree fed by both seeds — the
    // BFS-convergence path must process them once per seed without
    // double-counting, then assign the single correct phase.
    await h.service.removeNode({ workflowId, nodeId: m });
    expect((await h.service.getNode(a)).phase).toBe(1);
    expect((await h.service.getNode(b)).phase).toBe(1);
    expect((await h.service.getNode(d)).phase).toBe(2);
    expect((await h.service.getNode(e)).phase).toBe(2);

    // Idempotence: a second multi-seed recompute over the same
    // overlapping descendants must NOT shift phases. Trigger via
    // `addSubgraph` with a temp T that fans out to BOTH D and E and
    // whose own phase (1, as a child of coord) matches the existing
    // max-parent-phase of {D, E}. Multi-seed recompute runs over
    // {D, E}; the new max-parent-phase is still 1 → phases stable.
    await h.service.addSubgraph({
      workflowId,
      nodes: [
        {
          tempId: "t",
          kind: "worker",
          spec: { agent: "w", brief: "t" },
          existingParents: [coord],
        },
      ],
      edges: [
        { from: { kind: "temp", tempId: "t" }, to: { kind: "existing", id: d } },
        { from: { kind: "temp", tempId: "t" }, to: { kind: "existing", id: e } },
      ],
    });
    expect((await h.service.getNode(a)).phase).toBe(1);
    expect((await h.service.getNode(b)).phase).toBe(1);
    expect((await h.service.getNode(d)).phase).toBe(2);
    expect((await h.service.getNode(e)).phase).toBe(2);
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
    await h.service.cancelWorkflow({ workflowId, cancellation: { kind: "user", message: "" } });
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

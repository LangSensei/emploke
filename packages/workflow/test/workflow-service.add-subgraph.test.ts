import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MultipleSuccessorCoordsError,
  OrphanCoordInsertError,
  ParentStateError,
  WorkflowAlreadyTerminalError,
  WorkflowNodeNotMutableError,
  WorkflowSubgraphCyclicError,
  WorkflowSubgraphEmptyError,
  WorkflowSubgraphMultipleCoordTempsError,
  WorkflowSubgraphNodeRefUnresolvedError,
  WorkflowSubgraphTempIdInvalidError,
  WorkflowSubgraphTempParentlessError,
} from "../src/errors.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.addSubgraph", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  // ─── Happy paths ─────────────────────────────────────────

  it("inserts a 2-node worker chain rooted at the caller", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const res = await h.service.addSubgraph({
      workflowId,
      nodes: [
        {
          tempId: "t-a",
          kind: "worker",
          spec: { agent: "w", brief: "a" },
          existingParents: [initialCoordNodeId],
        },
        {
          tempId: "t-b",
          kind: "worker",
          spec: { agent: "w", brief: "b" },
          existingParents: [],
        },
        // Trailing coord temp to satisfy §3 invariant (leaves = {1 coord}).
        {
          tempId: "t-end",
          kind: "coordinator",
          spec: { agent: "coord-end" },
          existingParents: [initialCoordNodeId],
        },
      ],
      edges: [
        { from: { kind: "temp", tempId: "t-a" }, to: { kind: "temp", tempId: "t-b" } },
        { from: { kind: "temp", tempId: "t-b" }, to: { kind: "temp", tempId: "t-end" } },
      ],
    });
    expect(res.insertedNodes.length).toBe(3);
    const tA = res.insertedNodes.find((n) => n.tempId === "t-a")!;
    const tB = res.insertedNodes.find((n) => n.tempId === "t-b")!;
    const tEnd = res.insertedNodes.find((n) => n.tempId === "t-end")!;
    expect(tA.phase).toBe(1);
    expect(tB.phase).toBe(2);
    // Verify the persisted DAG matches.
    const dag = await h.service.getDag(workflowId);
    expect(dag.nodes.map((n) => n.id).sort()).toEqual(
      [initialCoordNodeId, tA.nodeId, tB.nodeId, tEnd.nodeId].sort(),
    );
    const edgeSet = new Set(dag.edges.map((e) => `${e.from}->${e.to}`));
    expect(edgeSet.has(`${initialCoordNodeId}->${tA.nodeId}`)).toBe(true);
    expect(edgeSet.has(`${tA.nodeId}->${tB.nodeId}`)).toBe(true);
  });

  it("inserts a 5-node DAG with mixed existing + intra-batch parents", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // First land an existing worker root that some temps can attach
    // to as an existingParent.
    const { nodeId: existingRoot } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "root" },
      parents: [initialCoordNodeId],
    });
    const res = await h.service.addSubgraph({
      workflowId,
      nodes: [
        {
          tempId: "t1",
          kind: "worker",
          spec: { agent: "w", brief: "1" },
          existingParents: [existingRoot],
        },
        {
          tempId: "t2",
          kind: "worker",
          spec: { agent: "w", brief: "2" },
          existingParents: [existingRoot],
        },
        {
          tempId: "t3",
          kind: "worker",
          spec: { agent: "w", brief: "3" },
          existingParents: [],
        },
        {
          tempId: "t4",
          kind: "worker",
          spec: { agent: "w", brief: "4" },
          existingParents: [],
        },
        {
          tempId: "t5",
          kind: "worker",
          spec: { agent: "w", brief: "5" },
          existingParents: [],
        },
        // Trailing coord temp to satisfy §3 invariant (leaves = {1 coord}).
        {
          tempId: "t-end",
          kind: "coordinator",
          spec: { agent: "coord-end" },
          existingParents: [initialCoordNodeId],
        },
      ],
      edges: [
        { from: { kind: "temp", tempId: "t1" }, to: { kind: "temp", tempId: "t3" } },
        { from: { kind: "temp", tempId: "t2" }, to: { kind: "temp", tempId: "t3" } },
        { from: { kind: "temp", tempId: "t3" }, to: { kind: "temp", tempId: "t4" } },
        { from: { kind: "temp", tempId: "t3" }, to: { kind: "temp", tempId: "t5" } },
        { from: { kind: "temp", tempId: "t4" }, to: { kind: "temp", tempId: "t-end" } },
        { from: { kind: "temp", tempId: "t5" }, to: { kind: "temp", tempId: "t-end" } },
      ],
    });
    expect(res.insertedNodes.length).toBe(6);
    const byTemp = new Map(res.insertedNodes.map((n) => [n.tempId, n]));
    // existingRoot is phase 1 (child of coord at phase 0). t1/t2
    // attach to it → phase 2. t3 attaches to t1 and t2 → phase 3.
    // t4 and t5 attach to t3 → phase 4.
    expect(byTemp.get("t1")!.phase).toBe(2);
    expect(byTemp.get("t2")!.phase).toBe(2);
    expect(byTemp.get("t3")!.phase).toBe(3);
    expect(byTemp.get("t4")!.phase).toBe(4);
    expect(byTemp.get("t5")!.phase).toBe(4);
  });

  it("inserts a coord temp child of the caller and refreshes the denorm", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const res = await h.service.addSubgraph({
      workflowId,
      nodes: [
        {
          tempId: "next-coord",
          kind: "coordinator",
          spec: { agent: "coord-v2" },
          existingParents: [initialCoordNodeId],
        },
      ],
      edges: [],
    });
    expect(res.insertedNodes.length).toBe(1);
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.coordinatorAgent).toBe("coord-v2");
  });

  it("recomputes phase on existing not_started to-nodes that gain a temp parent", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Existing chain: coord(0) → w1(1) → w2(2).
    const { nodeId: w1 } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "w1" },
      parents: [initialCoordNodeId],
    });
    const { nodeId: w2 } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "w2" },
      parents: [w1],
    });
    expect((await h.service.getNode(w2)).phase).toBe(2);
    // Batch: add a new temp tNew rooted at w2, and (key part) add an
    // edge from coord → w2-via-tNew chain shouldn't matter. Instead
    // attach a new temp parent that itself sits ABOVE w1 in phase
    // (parents = w1, w2 child = w1+tNew). Cleaner: temp tBig anchored
    // to w2 as a child, then edge tBig → w2 isn't possible (cycle).
    // Use the simpler shape: add tDeep as a child of w1, then add
    // edge tDeep → w2. w2 now has parents {w1, tDeep}; tDeep has
    // phase = w1.phase+1 = 2; so w2 grows to 3.
    await h.service.addSubgraph({
      workflowId,
      nodes: [
        {
          tempId: "tDeep",
          kind: "worker",
          spec: { agent: "w", brief: "deep" },
          existingParents: [w1],
        },
        // Trailing coord temp to satisfy §3 invariant (leaves = {1 coord}).
        {
          tempId: "tEnd",
          kind: "coordinator",
          spec: { agent: "coord-end" },
          existingParents: [initialCoordNodeId],
        },
      ],
      edges: [
        { from: { kind: "temp", tempId: "tDeep" }, to: { kind: "existing", id: w2 } },
        { from: { kind: "existing", id: w2 }, to: { kind: "temp", tempId: "tEnd" } },
      ],
    });
    expect((await h.service.getNode(w2)).phase).toBe(3);
  });

  // ─── Sad paths: shape validation ─────────────────────────

  it("REJECTS empty nodes array", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({ workflowId, nodes: [], edges: [] }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphEmptyError);
  });

  it("REJECTS duplicate tempIds", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "dup",
            kind: "worker",
            spec: { agent: "w", brief: "a" },
            existingParents: [initialCoordNodeId],
          },
          {
            tempId: "dup",
            kind: "worker",
            spec: { agent: "w", brief: "b" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphTempIdInvalidError);
  });

  it("REJECTS empty-string tempId", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "",
            kind: "worker",
            spec: { agent: "w", brief: "a" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphTempIdInvalidError);
  });

  it("REJECTS a parentless temp", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "lonely",
            kind: "worker",
            spec: { agent: "w", brief: "x" },
            existingParents: [],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphTempParentlessError);
  });

  it("REJECTS an edge that references an undeclared temp", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "a",
            kind: "worker",
            spec: { agent: "w", brief: "a" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [{ from: { kind: "temp", tempId: "a" }, to: { kind: "temp", tempId: "ghost" } }],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphNodeRefUnresolvedError);
  });

  it("REJECTS more than one coord temp", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "c1",
            kind: "coordinator",
            spec: { agent: "coord-1" },
            existingParents: [initialCoordNodeId],
          },
          {
            tempId: "c2",
            kind: "coordinator",
            spec: { agent: "coord-2" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphMultipleCoordTempsError);
  });

  it("REJECTS an intra-batch cycle", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "a",
            kind: "worker",
            spec: { agent: "w", brief: "a" },
            existingParents: [initialCoordNodeId],
          },
          {
            tempId: "b",
            kind: "worker",
            spec: { agent: "w", brief: "b" },
            existingParents: [],
          },
        ],
        edges: [
          { from: { kind: "temp", tempId: "a" }, to: { kind: "temp", tempId: "b" } },
          { from: { kind: "temp", tempId: "b" }, to: { kind: "temp", tempId: "a" } },
        ],
      }),
    ).rejects.toThrow(/cycle/);
  });

  it("REJECTS a joined-DAG cycle via an existing edge", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Existing: coord → a → b
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
    // Batch: insert temp t with parent = b, and edge t → a. That
    // closes a cycle a → b → t → a.
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "t" },
            existingParents: [b],
          },
        ],
        edges: [{ from: { kind: "temp", tempId: "t" }, to: { kind: "existing", id: a } }],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphCyclicError);
  });

  // ─── Sad paths: existing-ref resolution ──────────────────

  it("REJECTS an unresolved existing-ref parent", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "x" },
            existingParents: [VALID_UUIDS[15]!],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphNodeRefUnresolvedError);
  });

  it("rejects an unresolved existingParents ref BEFORE calling runner.validate (P15-c Pass A)", async () => {
    const { workflowId } = await bootstrap(h);
    // Bootstrap only invokes the coord runner's validate; the worker
    // runner is untouched. Snapshot the worker spy at 0 so any leak
    // into Pass B (the per-temp runner.validate loop) is visible.
    expect(h.workerRunner.validateCalls.length).toBe(0);
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "x" },
            existingParents: [VALID_UUIDS[15]!],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphNodeRefUnresolvedError);
    // Pass A short-circuited before Pass B fired runner.validate.
    expect(h.workerRunner.validateCalls.length).toBe(0);
  });

  it("REJECTS a cross-workflow existing-ref", async () => {
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
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "x" },
            existingParents: [otherTask],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowSubgraphNodeRefUnresolvedError);
  });

  it("REJECTS when an existing to-node is not not_started", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: target } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: target,
        status: "running",
        runningAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "t" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [{ from: { kind: "temp", tempId: "t" }, to: { kind: "existing", id: target } }],
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotMutableError);
  });

  // ─── Happy paths: input normalization (P15-a) ────────────

  it("dedupes duplicate existingParents within a temp (P15-a)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Caller passes the same parent ref three times. The substrate
    // must silently collapse to a single edge (matches `addNode`'s
    // `Array.from(new Set(args.parents))` convention) rather than
    // surfacing a composite-PK violation as a generic SQLite error.
    const res = await h.service.addSubgraph({
      workflowId,
      nodes: [
        {
          tempId: "t",
          kind: "worker",
          spec: { agent: "w", brief: "x" },
          existingParents: [initialCoordNodeId, initialCoordNodeId, initialCoordNodeId],
        },
        // Trailing coord temp to satisfy §3 invariant (leaves = {1 coord}).
        {
          tempId: "t-end",
          kind: "coordinator",
          spec: { agent: "coord-end" },
          existingParents: [initialCoordNodeId],
        },
      ],
      edges: [{ from: { kind: "temp", tempId: "t" }, to: { kind: "temp", tempId: "t-end" } }],
    });
    expect(res.insertedNodes.length).toBe(2);
    const t = res.insertedNodes.find((n) => n.tempId === "t")!;
    expect(t.phase).toBe(1);
    // Exactly one edge from coord → t (dedup collapsed the triple).
    const dag = await h.service.getDag(workflowId);
    const incoming = dag.edges.filter((e) => e.to === t.nodeId);
    expect(incoming.length).toBe(1);
    expect(incoming[0]!.from).toBe(initialCoordNodeId);
  });

  it("dedupes duplicate edges entries by (from, to) identity (P15-a)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const res = await h.service.addSubgraph({
      workflowId,
      nodes: [
        {
          tempId: "a",
          kind: "worker",
          spec: { agent: "w", brief: "a" },
          existingParents: [initialCoordNodeId],
        },
        {
          tempId: "b",
          kind: "worker",
          spec: { agent: "w", brief: "b" },
          existingParents: [],
        },
        // Trailing coord temp to satisfy §3 invariant (leaves = {1 coord}).
        {
          tempId: "t-end",
          kind: "coordinator",
          spec: { agent: "coord-end" },
          existingParents: [initialCoordNodeId],
        },
      ],
      // Same (from, to) pair declared twice — collapse to one edge.
      edges: [
        { from: { kind: "temp", tempId: "a" }, to: { kind: "temp", tempId: "b" } },
        { from: { kind: "temp", tempId: "a" }, to: { kind: "temp", tempId: "b" } },
        { from: { kind: "temp", tempId: "b" }, to: { kind: "temp", tempId: "t-end" } },
      ],
    });
    expect(res.insertedNodes.length).toBe(3);
    const aNode = res.insertedNodes.find((n) => n.tempId === "a")!;
    const bNode = res.insertedNodes.find((n) => n.tempId === "b")!;
    const dag = await h.service.getDag(workflowId);
    const aToBs = dag.edges.filter((e) => e.from === aNode.nodeId && e.to === bNode.nodeId);
    expect(aToBs.length).toBe(1);
  });

  // ─── Sad paths: parent-state + D-rules ───────────────────

  it("REJECTS a worker temp with a `failed` existing parent (D29)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: deadParent } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: deadParent,
        status: "failed",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "t" },
            existingParents: [deadParent],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(ParentStateError);
  });

  it("REJECTS a coord temp without the caller as a parent (D27)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: someWorker } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "w", brief: "x" },
      parents: [initialCoordNodeId],
    });
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "c",
            kind: "coordinator",
            spec: { agent: "coord-v2" },
            existingParents: [someWorker],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(OrphanCoordInsertError);
  });

  it("REJECTS a coord temp when the caller already has a coord-kind child (D23)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Pre-existing coord child of the caller.
    await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-pre" },
      parents: [initialCoordNodeId],
    });
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "c",
            kind: "coordinator",
            spec: { agent: "coord-batch" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(MultipleSuccessorCoordsError);
  });

  it("REJECTS when runner.validate throws", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    h.workerRunner.validateShouldThrow = new Error("bad temp spec");
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "x" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [],
      }),
    ).rejects.toThrow("bad temp spec");
  });

  // ─── Workflow lifecycle gate ─────────────────────────────

  it("REJECTS when workflow is terminal (cancel race)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await h.service.cancelWorkflow({ workflowId, cancellation: { kind: "user", message: "" } });
    await expect(
      h.service.addSubgraph({
        workflowId,
        nodes: [
          {
            tempId: "t",
            kind: "worker",
            spec: { agent: "w", brief: "x" },
            existingParents: [initialCoordNodeId],
          },
        ],
        edges: [],
      }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyTerminalError);
  });
});

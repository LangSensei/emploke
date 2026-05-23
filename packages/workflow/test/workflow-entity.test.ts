import { describe, expect, it } from "vitest";
import {
  CorruptedWorkflowError,
  InvalidWorkflowTransitionError,
  WorkflowCycleError,
  WorkflowNodeNotReadyError,
} from "../src/errors.js";
import { Workflow } from "../src/workflow-entity.js";

const T0 = "2026-05-22T00:00:00.000Z";
const T1 = "2026-05-22T00:00:01.000Z";
const T2 = "2026-05-22T00:00:02.000Z";

function blankWorkflow(): Workflow {
  return Workflow.create({
    id: "20260522-aaaa0001",
    brief: "test workflow",
    createdAt: T0,
  });
}

function withTwoNodes(wf: Workflow): {
  wf: Workflow;
  a: string;
  b: string;
} {
  const a = "20260522-bbbb0001";
  const b = "20260522-bbbb0002";
  const next = wf
    .addNode({
      id: a,
      type: "task",
      spec: { agent: "agent-a", brief: "node a" },
      createdAt: T0,
    })
    .addNode({
      id: b,
      type: "task",
      spec: { agent: "agent-b", brief: "node b" },
      createdAt: T0,
    });
  return { wf: next, a, b };
}

describe("Workflow entity — construction", () => {
  it("create initialises to status=not_started, no outcome, no started_at", () => {
    const wf = blankWorkflow();
    expect(wf.status).toBe("not_started");
    expect(wf.outcome).toBeUndefined();
    expect(wf.startedAt).toBeUndefined();
    expect(wf.nodes).toHaveLength(0);
    expect(wf.edges).toHaveLength(0);
  });

  it("create rejects invalid workflow id format", () => {
    expect(() => Workflow.create({ id: "not-a-real-id", brief: "x", createdAt: T0 })).toThrow(
      CorruptedWorkflowError,
    );
  });

  it("create rejects empty brief", () => {
    expect(() => Workflow.create({ id: "20260522-aaaa0001", brief: "", createdAt: T0 })).toThrow(
      CorruptedWorkflowError,
    );
  });
});

describe("Workflow entity — append-only nodes", () => {
  it("addNode appends a not_started node", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    expect(wf.nodes).toHaveLength(2);
    expect(wf.node(a)?.status).toBe("not_started");
  });

  it("addNode rejects duplicate id", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    expect(() =>
      wf.addNode({
        id: a,
        type: "task",
        spec: { agent: "x", brief: "y" },
        createdAt: T0,
      }),
    ).toThrow(CorruptedWorkflowError);
  });

  it("addNode rejects non-task type in v1", () => {
    const wf = blankWorkflow();
    expect(() =>
      wf.addNode({
        id: "20260522-bbbb0001",
        type: "human" as unknown as "task",
        spec: { agent: "a", brief: "b" },
        createdAt: T0,
      }),
    ).toThrow(InvalidWorkflowTransitionError);
  });

  it("addNode rejects spec missing agent/brief", () => {
    const wf = blankWorkflow();
    expect(() =>
      wf.addNode({
        id: "20260522-bbbb0001",
        type: "task",
        spec: { agent: "", brief: "b" },
        createdAt: T0,
      }),
    ).toThrow(InvalidWorkflowTransitionError);
  });

  it("no removeNode API on the entity surface", () => {
    const wf = blankWorkflow();
    expect((wf as unknown as { removeNode?: unknown }).removeNode).toBeUndefined();
  });
});

describe("Workflow entity — DAG / cycle rejection", () => {
  it("addEdge connects two existing not_started nodes", () => {
    const { wf, a, b } = withTwoNodes(blankWorkflow());
    const next = wf.addEdge(a, b);
    expect(next.edges).toEqual([{ from: a, to: b }]);
    expect(next.upstreamOf(b)).toEqual([a]);
    expect(next.downstreamOf(a)).toEqual([b]);
  });

  it("addEdge rejects self-loop as cycle", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    expect(() => wf.addEdge(a, a)).toThrow(WorkflowCycleError);
  });

  it("addEdge rejects direct cycle (a→b then b→a)", () => {
    const { wf, a, b } = withTwoNodes(blankWorkflow());
    const next = wf.addEdge(a, b);
    expect(() => next.addEdge(b, a)).toThrow(WorkflowCycleError);
  });

  it("addEdge rejects indirect cycle (a→b→c then c→a)", () => {
    const a = "20260522-bbbb0001";
    const b = "20260522-bbbb0002";
    const c = "20260522-bbbb0003";
    const wf = blankWorkflow()
      .addNode({ id: a, type: "task", spec: { agent: "x", brief: "a" }, createdAt: T0 })
      .addNode({ id: b, type: "task", spec: { agent: "x", brief: "b" }, createdAt: T0 })
      .addNode({ id: c, type: "task", spec: { agent: "x", brief: "c" }, createdAt: T0 })
      .addEdge(a, b)
      .addEdge(b, c);
    expect(() => wf.addEdge(c, a)).toThrow(WorkflowCycleError);
  });

  it("addEdge rejects unknown endpoint", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    expect(() => wf.addEdge(a, "20260522-ffff9999")).toThrow(CorruptedWorkflowError);
  });

  it("addEdge rejects duplicate", () => {
    const { wf, a, b } = withTwoNodes(blankWorkflow());
    const once = wf.addEdge(a, b);
    expect(() => once.addEdge(a, b)).toThrow(CorruptedWorkflowError);
  });

  it("addEdge rejects edge into non-not_started node (edges immutable post-launch)", () => {
    const { wf, a, b } = withTwoNodes(blankWorkflow());
    // Launch b directly (no upstream), then try to add an edge into it.
    const launched = wf.launchNode(b, T1);
    expect(() => launched.addEdge(a, b)).toThrow(InvalidWorkflowTransitionError);
  });
});

describe("Workflow entity — node state machine", () => {
  it("launchNode on a no-upstream node transitions to running", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    const next = wf.launchNode(a, T1);
    expect(next.node(a)?.status).toBe("running");
    expect(next.node(a)?.runningAt).toBe(T1);
    expect(next.status).toBe("running");
    expect(next.startedAt).toBe(T1);
  });

  it("launchNode refuses when an upstream is still not_started", () => {
    const { wf, a, b } = withTwoNodes(blankWorkflow());
    const edged = wf.addEdge(a, b);
    expect(() => edged.launchNode(b, T1)).toThrow(WorkflowNodeNotReadyError);
  });

  it("markDone auto-promotes downstream not_started → ready when all deps succeeded", () => {
    const { wf, a, b } = withTwoNodes(blankWorkflow());
    const edged = wf.addEdge(a, b);
    const launched = edged.launchNode(a, T1);
    const done = launched.markNodeDone(
      a,
      { task_id: "20260522-cccc0001", success: { output: "ok" } },
      T2,
    );
    expect(done.node(a)?.status).toBe("succeeded");
    expect(done.node(b)?.status).toBe("ready");
    expect(done.node(b)?.readyAt).toBe(T2);
  });

  it("markDone with a partial-success dependency set does NOT promote downstream", () => {
    const a = "20260522-bbbb0001";
    const b = "20260522-bbbb0002";
    const c = "20260522-bbbb0003";
    const wf = blankWorkflow()
      .addNode({ id: a, type: "task", spec: { agent: "x", brief: "a" }, createdAt: T0 })
      .addNode({ id: b, type: "task", spec: { agent: "x", brief: "b" }, createdAt: T0 })
      .addNode({ id: c, type: "task", spec: { agent: "x", brief: "c" }, createdAt: T0 })
      .addEdge(a, c)
      .addEdge(b, c);
    const launched = wf.launchNode(a, T1);
    const oneDone = launched.markNodeDone(a, {}, T2);
    expect(oneDone.node(c)?.status).toBe("not_started");
  });

  it("markFailed does NOT cascade-cancel downstream (CEO O5)", () => {
    const { wf, a, b } = withTwoNodes(blankWorkflow());
    const edged = wf.addEdge(a, b);
    const launched = edged.launchNode(a, T1);
    const failed = launched.markNodeFailed(a, { failure: { kind: "exited" } }, T2);
    expect(failed.node(a)?.status).toBe("failed");
    expect(failed.node(b)?.status).toBe("not_started");
  });

  it("markDone on a non-running node throws InvalidWorkflowTransitionError", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    expect(() => wf.markNodeDone(a, {}, T1)).toThrow(InvalidWorkflowTransitionError);
  });

  it("markFailed on a non-running node throws", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    expect(() => wf.markNodeFailed(a, {}, T1)).toThrow(InvalidWorkflowTransitionError);
  });

  it("launchNode on a terminal node throws (forward-only)", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    const done = wf.launchNode(a, T1).markNodeDone(a, {}, T2);
    expect(() => done.launchNode(a, T2)).toThrow(InvalidWorkflowTransitionError);
  });
});

describe("Workflow entity — cancelNode (hard-guarded per CEO O5)", () => {
  it("cancelNode succeeds when status is not_started", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    const cancelled = wf.cancelNode(a, { reason: "user" }, T1);
    expect(cancelled.node(a)?.status).toBe("cancelled");
    expect(cancelled.node(a)?.endedAt).toBe(T1);
  });

  it("cancelNode refuses when status is ready", () => {
    const { wf, a, b } = withTwoNodes(blankWorkflow());
    const edged = wf.addEdge(a, b);
    const promoted = edged.launchNode(a, T1).markNodeDone(a, {}, T2);
    expect(promoted.node(b)?.status).toBe("ready");
    expect(() => promoted.cancelNode(b, {}, T2)).toThrow(InvalidWorkflowTransitionError);
  });

  it("cancelNode refuses when status is running", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    const running = wf.launchNode(a, T1);
    expect(() => running.cancelNode(a, {}, T2)).toThrow(InvalidWorkflowTransitionError);
  });

  it("cancelNode refuses when status is succeeded/failed/cancelled", () => {
    const { wf, a } = withTwoNodes(blankWorkflow());
    const done = wf.launchNode(a, T1).markNodeDone(a, {}, T2);
    expect(() => done.cancelNode(a, {}, T2)).toThrow(InvalidWorkflowTransitionError);
  });
});

describe("Workflow entity — archive / outcome invariant", () => {
  it("archive stamps outcome + archived_at and forbids re-archive", () => {
    const wf = blankWorkflow();
    const arch = wf.archive("cancelled", T2);
    expect(arch.status).toBe("archived");
    expect(arch.outcome).toBe("cancelled");
    expect(arch.archivedAt).toBe(T2);
    expect(() => arch.archive("succeeded", T2)).toThrow(InvalidWorkflowTransitionError);
  });

  it("fromStored rejects archived workflow without outcome", () => {
    expect(() =>
      Workflow.fromStored({
        id: "20260522-aaaa0001",
        brief: "x",
        status: "archived",
        metadata: {},
        createdAt: T0,
        nodes: [],
        edges: [],
      }),
    ).toThrow(CorruptedWorkflowError);
  });

  it("fromStored rejects outcome without archived status", () => {
    expect(() =>
      Workflow.fromStored({
        id: "20260522-aaaa0001",
        brief: "x",
        status: "running",
        outcome: "succeeded",
        metadata: {},
        createdAt: T0,
        nodes: [],
        edges: [],
      }),
    ).toThrow(CorruptedWorkflowError);
  });
});

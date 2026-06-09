import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EmptyParentsError,
  MultipleSuccessorCoordsError,
  OrphanCoordInsertError,
  ParentStateError,
  WorkflowAlreadyTerminalError,
  WorkflowNodeNotFoundError,
  WorkflowNotFoundError,
} from "../src/errors.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService.addNode", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  // ─── Happy path + phase ───────────────────────────────────

  it("adds a worker-kind node and assigns phase = MAX(parents.phase) + 1", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId, phase } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "x" },
      parents: [initialCoordNodeId],
    });
    // initialCoord phase = 0, so child phase = 1.
    expect(phase).toBe(1);
    const node = await h.service.getNode(nodeId);
    expect(node.kind).toBe("worker");
    expect(node.phase).toBe(1);
  });

  it("threads validate ctx with the workflow id and status", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Drain createWorkflow's validate call so we can assert on the
    // next one.
    h.coordRunner.validateCalls.length = 0;
    h.workerRunner.validateCalls.length = 0;
    await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "x" },
      parents: [initialCoordNodeId],
    });
    expect(h.workerRunner.validateCalls).toHaveLength(1);
    const v = h.workerRunner.validateCalls[0]!;
    expect(v.ctx.workflowId).toBe(workflowId);
    expect(v.ctx.workflowStatus).toBe("running");
  });

  // ─── Kind-aware parent-state restriction ─────────────────

  it("REJECTS a worker-kind node whose parent is `failed`", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: parentId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "x" },
      parents: [initialCoordNodeId],
    });
    // Force the parent to `failed`.
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentId,
        status: "failed",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.addNode({
        workflowId,
        kind: "worker",
        spec: { agent: "writer", brief: "y" },
        parents: [parentId],
      }),
    ).rejects.toBeInstanceOf(ParentStateError);
  });

  it("REJECTS a worker-kind node whose parent is `cancelled`", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: parentId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "x" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentId,
        status: "cancelled",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    await expect(
      h.service.addNode({
        workflowId,
        kind: "worker",
        spec: { agent: "writer", brief: "y" },
        parents: [parentId],
      }),
    ).rejects.toBeInstanceOf(ParentStateError);
  });

  it("ALLOWS a coordinator-kind node whose parent is `failed` (coord wakes on failure)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: parentId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "x" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentId,
        status: "failed",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    // The new coord's parents must include the caller (orphan-coord
    // rule), so attach both the failed task AND the caller.
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-b" },
      parents: [initialCoordNodeId, parentId],
    });
    const node = await h.service.getNode(nodeId);
    expect(node.kind).toBe("coordinator");
  });

  // ─── Coord-kind structural rules ─────────────────────────

  it("REJECTS a coord-kind insert that does NOT list the caller as a parent (orphan)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: peerTaskId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "x" },
      parents: [initialCoordNodeId],
    });
    await expect(
      h.service.addNode({
        workflowId,
        kind: "coordinator",
        spec: { agent: "coord-b" },
        parents: [peerTaskId],
      }),
    ).rejects.toBeInstanceOf(OrphanCoordInsertError);
  });

  it("REJECTS a coord-kind insert when the caller already has a coord-kind child", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-b" },
      parents: [initialCoordNodeId],
    });
    await expect(
      h.service.addNode({
        workflowId,
        kind: "coordinator",
        spec: { agent: "coord-c" },
        parents: [initialCoordNodeId],
      }),
    ).rejects.toBeInstanceOf(MultipleSuccessorCoordsError);
  });

  it("denorm invariant: coord-kind insert updates `workflows.coordinator_agent` atomically with the INSERT", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await h.service.addNode({
      workflowId,
      kind: "coordinator",
      spec: { agent: "coord-b" },
      parents: [initialCoordNodeId],
    });
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.coordinatorAgent).toBe("coord-b");
  });

  // ─── Auth gate (R4: derived from workflowId) ─────────────

  it("REJECTS when workflowId does not exist", async () => {
    await bootstrap(h);
    await expect(
      h.service.addNode({
        workflowId: VALID_UUIDS[15]!,
        kind: "worker",
        spec: { agent: "x", brief: "y" },
        parents: [VALID_UUIDS[14]!],
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("REJECTS when the workflow is already terminal (cancelled)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    await h.service.cancelWorkflow({ workflowId, cancellation: { kind: "user", message: "" } });
    await expect(
      h.service.addNode({
        workflowId,
        kind: "worker",
        spec: { agent: "writer", brief: "x" },
        parents: [initialCoordNodeId],
      }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyTerminalError);
  });

  it("REJECTS when a parent id refers to a node in a different workflow", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Bootstrap a second workflow with its own coord; try to attach
    // a node in `workflowId` to a parent in the OTHER workflow.
    const { initialCoordNodeId: otherCoord } = await h.service.createWorkflow({
      brief: "other",
      coordinatorAgent: "coord-x",
    });
    await expect(
      h.service.addNode({
        workflowId,
        kind: "worker",
        spec: { agent: "writer", brief: "x" },
        parents: [initialCoordNodeId, otherCoord],
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
  });

  // ─── Closed-kind enum ─────────────────────────────────────
  //
  // The substrate's `AddNodeArgs.kind` field is typed `NodeKind`
  // (`'coordinator' | 'worker'`). Inserting an unknown kind is a
  // TypeScript compile error rather than a runtime throw — see
  // `public-api-guard.test.ts` for the type-level assertion. No
  // runtime test is needed because the bad path is unreachable
  // through the typed surface.

  it("throws WorkflowNodeNotFoundError when a parent id does not exist", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.addNode({
        workflowId,
        kind: "worker",
        spec: { agent: "writer", brief: "x" },
        parents: [VALID_UUIDS[15]!],
      }),
    ).rejects.toBeInstanceOf(WorkflowNodeNotFoundError);
  });

  // ─── Eager dispatch reaction ─────────────────────────────

  it("eager dispatch: fires `dispatchAtomic` when the new task's parents are all already `succeeded`", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const { nodeId: parentTaskId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "p" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentTaskId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    h.workerRunner.dispatchCalls.length = 0;
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "child" },
      parents: [parentTaskId],
    });
    // The eager-dispatch reaction must fire — otherwise the child
    // would sit in not_started forever (no future parent-termination
    // event will arrive in this PR's substrate).
    const child = await h.service.getNode(nodeId);
    expect(child.status).toBe("running");
    expect(h.workerRunner.dispatchCalls.map((c) => c.nodeId)).toContain(nodeId);
  });

  it("eager dispatch: does NOT fire when parents are still running", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const parent = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "p" },
      parents: [initialCoordNodeId],
    });
    // Leave parent in not_started (because its parent coord is still
    // running, parent task never satisfied the readiness predicate).
    expect((await h.service.getNode(parent.nodeId)).status).toBe("not_started");
    h.workerRunner.dispatchCalls.length = 0;
    const child = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "c" },
      parents: [parent.nodeId],
    });
    expect((await h.service.getNode(child.nodeId)).status).toBe("not_started");
    expect(h.workerRunner.dispatchCalls.map((c) => c.nodeId)).not.toContain(child.nodeId);
  });

  it("eager dispatch: when all parents are already terminal, dispatches immediately", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Materialise a parent task and force it terminal so the new
    // task's parent-readiness predicate is satisfied at insert time.
    const { nodeId: parentTaskId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "p" },
      parents: [initialCoordNodeId],
    });
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: parentTaskId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    h.workerRunner.dispatchCalls.length = 0;
    const { nodeId } = await h.service.addNode({
      workflowId,
      kind: "worker",
      spec: { agent: "writer", brief: "child" },
      parents: [parentTaskId],
    });
    const n = await h.service.getNode(nodeId);
    expect(n.status).toBe("running");
    expect(h.workerRunner.dispatchCalls.map((c) => c.nodeId)).toContain(nodeId);
  });

  it("REJECTS when parents is empty", async () => {
    const { workflowId } = await bootstrap(h);
    await expect(
      h.service.addNode({
        workflowId,
        kind: "worker",
        spec: { agent: "writer", brief: "x" },
        parents: [],
      }),
    ).rejects.toBeInstanceOf(EmptyParentsError);
  });
});

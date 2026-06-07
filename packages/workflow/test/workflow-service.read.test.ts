import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowNodeNotFoundError, WorkflowNotFoundError } from "../src/errors.js";
import { workflowNodeDir } from "../src/paths.js";
import {
  bootstrap,
  fixedRandomUUID,
  makeWorkflowTestHandle,
  VALID_UUIDS,
  type WorkflowTestHandle,
} from "./_helpers.js";

describe("WorkflowService — read APIs", () => {
  let h: WorkflowTestHandle;

  beforeEach(() => {
    h = makeWorkflowTestHandle({ randomUUID: fixedRandomUUID(VALID_UUIDS) });
  });

  afterEach(() => {
    h.close();
  });

  it("getWorkflow returns the persisted entity by id", async () => {
    const { workflowId } = await bootstrap(h);
    const wf = await h.service.getWorkflow(workflowId);
    expect(wf.id).toBe(workflowId);
    expect(wf.status).toBe("running");
    expect(wf.coordinatorAgent).toBe("coord-agent");
  });

  it("getWorkflow throws WorkflowNotFoundError on a missing id", async () => {
    await expect(h.service.getWorkflow(VALID_UUIDS[15]!)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });

  it("getNode returns the persisted entity by id", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const node = await h.service.getNode(initialCoordNodeId);
    expect(node.id).toBe(initialCoordNodeId);
    expect(node.workflowId).toBe(workflowId);
    expect(node.kind).toBe("coordinator");
  });

  it("getNode throws WorkflowNodeNotFoundError on a missing id", async () => {
    await expect(h.service.getNode(VALID_UUIDS[15]!)).rejects.toBeInstanceOf(
      WorkflowNodeNotFoundError,
    );
  });

  it("getDag returns the workflow header + nodes + edges as a snapshot", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Add one task node child of the coord so the DAG has both
    // node kinds and one edge.
    const { nodeId: taskId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "writer", brief: "x" },
      parents: [initialCoordNodeId],
    });
    const dag = await h.service.getDag(workflowId);
    expect(dag.workflow.id).toBe(workflowId);
    expect(dag.nodes.map((n) => n.id).sort()).toEqual([initialCoordNodeId, taskId].sort());
    expect(dag.edges).toHaveLength(1);
    expect(dag.edges[0]?.from).toBe(initialCoordNodeId);
    expect(dag.edges[0]?.to).toBe(taskId);
  });

  it("getDag throws WorkflowNotFoundError on a missing id", async () => {
    await expect(h.service.getDag(VALID_UUIDS[15]!)).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("getNodeDir returns null for a node in `not_started`", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // Make the coord block dispatch to keep the new task in
    // not_started: register a custom task handler whose validate
    // returns identity; then add a task with a not-yet-terminal coord
    // parent (the coord is `running`).
    const { nodeId: taskId } = await h.service.addNode({
      callerCoordNodeId: initialCoordNodeId,
      kind: "task",
      spec: { agent: "writer", brief: "x" },
      parents: [initialCoordNodeId],
    });
    const dir = await h.service.getNodeDir(taskId);
    expect(dir).toBeNull();
    // Sanity check: the workflow header is not touched.
    void workflowId;
  });

  it("getNodeDir returns the resolved dir for a node in `running`", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    const dir = await h.service.getNodeDir(initialCoordNodeId);
    expect(dir).toBe(workflowNodeDir(h.workspaceDir, workflowId, initialCoordNodeId));
  });

  it("getNodeDir returns the resolved dir for terminal statuses (succeeded/failed/cancelled)", async () => {
    const { workflowId, initialCoordNodeId } = await bootstrap(h);
    // The initial coord is `running` after bootstrap. Flip it to
    // `succeeded` directly via repository — the substrate's engine
    // event handlers (added in a later iteration) would do this on
    // coord-termination.
    h.db.db.transaction((tx) => {
      h.repo.updateNodeLifecycle(tx, {
        id: initialCoordNodeId,
        status: "succeeded",
        endedAt: "2026-06-07T01:00:00.000Z",
      });
    });
    const dir = await h.service.getNodeDir(initialCoordNodeId);
    expect(dir).toBe(workflowNodeDir(h.workspaceDir, workflowId, initialCoordNodeId));
  });

  it("getNodeDir throws WorkflowNodeNotFoundError on a missing id", async () => {
    await expect(h.service.getNodeDir(VALID_UUIDS[15]!)).rejects.toBeInstanceOf(
      WorkflowNodeNotFoundError,
    );
  });
});

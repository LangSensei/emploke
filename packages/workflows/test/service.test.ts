import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidWorkflowTransitionError,
  WorkflowCycleError,
  WorkflowNodeNotReadyError,
  WorkflowNotFoundError,
} from "../src/errors.js";
import { WorkflowsRepository } from "../src/repository.js";
import { WorkflowsService } from "../src/service.js";
import { openTestWorkflowsDb } from "../src/testing.js";
import type { TaskDispatcher } from "../src/types.js";

let handle: ReturnType<typeof openTestWorkflowsDb>;
let service: WorkflowsService;
let dispatcher: TaskDispatcher & { calls: { agent: string; brief: string }[] };

/**
 * Deterministic timestamp + id generator so the FSM transitions
 * yield byte-exact values across runs.
 */
function makeNow(): () => Date {
  let n = 0;
  return () => {
    n++;
    return new Date(Date.UTC(2026, 4, 22, 0, 0, n));
  };
}

beforeEach(() => {
  handle = openTestWorkflowsDb();
  const repo = new WorkflowsRepository({ db: handle.db });
  let nextTaskId = 0;
  dispatcher = {
    calls: [],
    async dispatch(opts) {
      this.calls.push({ agent: opts.agent, brief: opts.brief });
      nextTaskId++;
      return { id: `20260522-cccc000${nextTaskId}` };
    },
  };
  service = new WorkflowsService({ repo, taskDispatcher: dispatcher, now: makeNow() });
});

afterEach(() => {
  handle.close();
});

describe("WorkflowsService — happy-path lifecycle", () => {
  it("creates a workflow, attaches a graph, launches a node, and finishes", async () => {
    const wf = await service.createWorkflow({ brief: "demo" });
    expect(wf.status).toBe("not_started");

    const a = await service.createNode(wf.id, {
      type: "task",
      spec: { agent: "agent-a", brief: "node a" },
    });
    const b = await service.createNode(wf.id, {
      type: "task",
      spec: { agent: "agent-b", brief: "node b" },
    });
    await service.addEdge(wf.id, a.id, b.id);

    const launched = await service.launchNode(wf.id, a.id);
    expect(launched.status).toBe("running");
    expect(dispatcher.calls).toEqual([{ agent: "agent-a", brief: "node a" }]);
    expect(launched.data.task_id).toBeDefined();

    const done = await service.markDone(wf.id, a.id, { success: { output: "ok" } });
    expect(done.status).toBe("succeeded");

    const state = await service.getState(wf.id);
    expect(state).not.toBeNull();
    expect(state?.nodes.find((n) => n.id === b.id)?.status).toBe("ready");

    const launchedB = await service.launchNode(wf.id, b.id);
    expect(launchedB.status).toBe("running");
    expect(dispatcher.calls).toHaveLength(2);

    await service.markDone(wf.id, b.id, { success: { output: "ok" } });

    const archived = await service.finishWorkflow(wf.id, "succeeded");
    expect(archived.status).toBe("archived");
    expect(archived.outcome).toBe("succeeded");
    expect(archived.archivedAt).toBeDefined();
  });
});

describe("WorkflowsService — guards", () => {
  it("throws WorkflowNotFoundError when accessing an unknown workflow", async () => {
    await expect(
      service.createNode("20260522-deadbeef", {
        type: "task",
        spec: { agent: "x", brief: "y" },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("addEdge rejects a cycle", async () => {
    const wf = await service.createWorkflow({ brief: "demo" });
    const a = await service.createNode(wf.id, { type: "task", spec: { agent: "x", brief: "a" } });
    const b = await service.createNode(wf.id, { type: "task", spec: { agent: "x", brief: "b" } });
    await service.addEdge(wf.id, a.id, b.id);
    await expect(service.addEdge(wf.id, b.id, a.id)).rejects.toBeInstanceOf(WorkflowCycleError);
  });

  it("launchNode rejects when an upstream node is still not_started", async () => {
    const wf = await service.createWorkflow({ brief: "demo" });
    const a = await service.createNode(wf.id, { type: "task", spec: { agent: "x", brief: "a" } });
    const b = await service.createNode(wf.id, { type: "task", spec: { agent: "x", brief: "b" } });
    await service.addEdge(wf.id, a.id, b.id);
    await expect(service.launchNode(wf.id, b.id)).rejects.toBeInstanceOf(WorkflowNodeNotReadyError);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("markDone on a running node and then mutating it again throws InvalidWorkflowTransitionError", async () => {
    const wf = await service.createWorkflow({ brief: "demo" });
    const a = await service.createNode(wf.id, { type: "task", spec: { agent: "x", brief: "a" } });
    await service.launchNode(wf.id, a.id);
    await service.markDone(wf.id, a.id, {});
    await expect(service.markDone(wf.id, a.id, {})).rejects.toBeInstanceOf(
      InvalidWorkflowTransitionError,
    );
  });

  it("cancelNode is hard-guarded — only legal from not_started (CEO O5)", async () => {
    const wf = await service.createWorkflow({ brief: "demo" });
    const a = await service.createNode(wf.id, { type: "task", spec: { agent: "x", brief: "a" } });
    // legal: still not_started
    const cancelled = await service.cancelNode(wf.id, a.id, { reason: "user" });
    expect(cancelled.status).toBe("cancelled");

    // Set up a second workflow so we can prove the guard on running.
    const wf2 = await service.createWorkflow({ brief: "demo 2" });
    const a2 = await service.createNode(wf2.id, {
      type: "task",
      spec: { agent: "x", brief: "a" },
    });
    await service.launchNode(wf2.id, a2.id);
    await expect(service.cancelNode(wf2.id, a2.id)).rejects.toBeInstanceOf(
      InvalidWorkflowTransitionError,
    );
  });

  it("finishWorkflow on an already-archived workflow throws", async () => {
    const wf = await service.createWorkflow({ brief: "demo" });
    await service.finishWorkflow(wf.id, "cancelled");
    await expect(service.finishWorkflow(wf.id, "succeeded")).rejects.toBeInstanceOf(
      InvalidWorkflowTransitionError,
    );
  });
});

describe("WorkflowsService — launchNode concurrency & dispatch failures", () => {
  it("two concurrent launchNode calls on the same node — exactly one wins, the other throws InvalidWorkflowTransitionError", async () => {
    const wf = await service.createWorkflow({ brief: "race" });
    const a = await service.createNode(wf.id, {
      type: "task",
      spec: { agent: "agent-a", brief: "node a" },
    });

    const results = await Promise.allSettled([
      service.launchNode(wf.id, a.id),
      service.launchNode(wf.id, a.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rej = rejected[0] as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(InvalidWorkflowTransitionError);

    // Dispatcher was only called once — the loser never made it past
    // the FSM guard.
    expect(dispatcher.calls).toHaveLength(1);

    const state = await service.getState(wf.id);
    const node = state?.nodes.find((n) => n.id === a.id);
    expect(node?.status).toBe("running");
    expect(node?.data.task_id).toBe("20260522-cccc0001");
  });

  it("parallel launches of two DIFFERENT ready nodes both succeed (fan-out is not over-serialized)", async () => {
    const wf = await service.createWorkflow({ brief: "fanout" });
    const a = await service.createNode(wf.id, {
      type: "task",
      spec: { agent: "agent-a", brief: "node a" },
    });
    const b = await service.createNode(wf.id, {
      type: "task",
      spec: { agent: "agent-b", brief: "node b" },
    });
    // No edge between them — both start ready.

    const results = await Promise.allSettled([
      service.launchNode(wf.id, a.id),
      service.launchNode(wf.id, b.id),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(dispatcher.calls).toHaveLength(2);

    const state = await service.getState(wf.id);
    const nodeA = state?.nodes.find((n) => n.id === a.id);
    const nodeB = state?.nodes.find((n) => n.id === b.id);
    expect(nodeA?.status).toBe("running");
    expect(nodeB?.status).toBe("running");
    expect(nodeA?.data.task_id).toMatch(/^20260522-cccc/);
    expect(nodeB?.data.task_id).toMatch(/^20260522-cccc/);
    expect(nodeA?.data.task_id).not.toBe(nodeB?.data.task_id);
  });

  it("dispatcher throw transitions the node to failed and rethrows the original error", async () => {
    // Build a dedicated service with a throwing dispatcher so we can
    // assert the failure path in isolation.
    const localHandle = openTestWorkflowsDb();
    try {
      const repo = new WorkflowsRepository({ db: localHandle.db });
      const dispatchError = new Error("dispatcher boom");
      const throwingDispatcher: TaskDispatcher = {
        async dispatch() {
          throw dispatchError;
        },
      };
      const local = new WorkflowsService({
        repo,
        taskDispatcher: throwingDispatcher,
        now: makeNow(),
      });

      const wf = await local.createWorkflow({ brief: "boom" });
      const a = await local.createNode(wf.id, {
        type: "task",
        spec: { agent: "agent-a", brief: "node a" },
      });

      await expect(local.launchNode(wf.id, a.id)).rejects.toBe(dispatchError);

      const state = await local.getState(wf.id);
      const node = state?.nodes.find((n) => n.id === a.id);
      expect(node?.status).toBe("failed");
      expect(node?.data.error).toBe("dispatch_failed");
      expect(node?.data.message).toBe("dispatcher boom");
      // The placeholder is still observable — the substrate records
      // exactly what it knew at each FSM transition.
      expect(node?.data.task_id).toBe("pending");
    } finally {
      localHandle.close();
    }
  });
});

describe("WorkflowsService — persistence round-trip", () => {
  it("save then read reconstitutes the full graph", async () => {
    const wf = await service.createWorkflow({ brief: "demo", details: "with detail" });
    const a = await service.createNode(wf.id, { type: "task", spec: { agent: "x", brief: "a" } });
    const b = await service.createNode(wf.id, { type: "task", spec: { agent: "x", brief: "b" } });
    await service.addEdge(wf.id, a.id, b.id);

    const state = await service.getState(wf.id);
    expect(state?.workflow.brief).toBe("demo");
    expect(state?.workflow.details).toBe("with detail");
    expect(state?.nodes).toHaveLength(2);
    expect(state?.edges).toEqual([{ workflowId: wf.id, from: a.id, to: b.id }]);
  });

  it("list returns every saved workflow", async () => {
    const a = await service.createWorkflow({ brief: "first" });
    const b = await service.createWorkflow({ brief: "second" });
    const all = await service.list();
    const ids = all.map((w) => w.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});

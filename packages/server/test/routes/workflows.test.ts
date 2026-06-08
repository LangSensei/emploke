/**
 * Route-level tests for `routes/workflows.ts`. Sibling of
 * `schedules.test.ts` — same stub-service pattern, same vitest
 * layout. Covers the 5-verb surface: list, create, get, dag, cancel,
 * plus the M2.5 coord-callback mutation surface (8 routes).
 *
 * Assertion surface:
 *   - happy-path passthrough to the injected `WorkflowService` stub
 *   - input validation 400s (status query, create body shape,
 *     mutation body shapes, NodeRefWire arms)
 *   - 404 mapping for `WorkflowNotFoundError`
 *   - 409 mapping for `WorkflowAlreadyTerminalError` /
 *     `WorkflowNodeNotMutableError` / `WorkflowEdgeCycleError` /
 *     `WorkflowRemoveNodeOrphansChildError`
 *   - 403 mapping for `WorkflowMutationUnauthorizedError`
 *   - wire-shape projection (flat per-kind node specs, ISO timestamps
 *     forwarded verbatim)
 *   - `iterationCount` derivation: 0 on list, coord-count-based on
 *     show / dag
 *   - cancel response is the post-cancel header (second getDag)
 *   - addSubgraph node-ref translation: both `{nodeId}` and `{tempId}`
 *     arms reach the substrate as the corresponding `NodeRef` tag
 */

import type { WorkflowDagSnapshot } from "@emploke/workflow";
import {
  WorkflowAlreadyTerminalError,
  WorkflowEdgeCycleError,
  WorkflowEdgeEntity,
  WorkflowEntity,
  WorkflowMutationUnauthorizedError,
  WorkflowNodeEntity,
  WorkflowNodeNotMutableError,
  WorkflowNotFoundError,
  WorkflowRemoveNodeOrphansChildError,
  type WorkflowService,
} from "@emploke/workflow";
import { describe, expect, it, vi } from "vitest";
import { workflowsRoutes } from "../../src/routes/workflows.js";

// ─── Fixtures ────────────────────────────────────────────────────────

const WID = "550e8400-e29b-41d4-a716-446655440000";
const COORD_NID = "550e8400-e29b-41d4-a716-446655440001";
const WORKER_NID = "550e8400-e29b-41d4-a716-446655440002";

function makeHeader(overrides: Partial<{ status: string; endedAt: string }> = {}): WorkflowEntity {
  return WorkflowEntity.fromRow({
    id: WID,
    brief: "ship feature X",
    details: null,
    coordinatorAgent: "coord-agent",
    status: (overrides.status ?? "running") as "running",
    metadata: "{}",
    createdAt: "2026-06-07T00:00:00.000Z",
    startedAt: "2026-06-07T00:00:00.000Z",
    endedAt: overrides.endedAt ?? null,
    success: null,
    failure: null,
    cancellation: null,
  });
}

function makeCoord(): WorkflowNodeEntity {
  return WorkflowNodeEntity.fromRow({
    id: COORD_NID,
    workflowId: WID,
    kind: "coordinator",
    specJson: JSON.stringify({ agent: "coord-agent" }),
    phase: 0,
    status: "running",
    createdAt: "2026-06-07T00:00:00.000Z",
    readyAt: "2026-06-07T00:00:00.000Z",
    runningAt: "2026-06-07T00:00:00.000Z",
    endedAt: null,
  });
}

function makeWorker(): WorkflowNodeEntity {
  return WorkflowNodeEntity.fromRow({
    id: WORKER_NID,
    workflowId: WID,
    kind: "worker",
    specJson: JSON.stringify({ agent: "writer", brief: "draft" }),
    phase: 1,
    status: "not_started",
    createdAt: "2026-06-07T00:00:01.000Z",
    readyAt: null,
    runningAt: null,
    endedAt: null,
  });
}

function makeDag(): WorkflowDagSnapshot {
  return {
    workflow: makeHeader(),
    nodes: [makeCoord(), makeWorker()],
    edges: [
      WorkflowEdgeEntity.fromRow({ workflowId: WID, fromNodeId: COORD_NID, toNodeId: WORKER_NID }),
    ],
  };
}

function stubService(overrides: Partial<Record<keyof WorkflowService, unknown>>): WorkflowService {
  const stub: Partial<Record<keyof WorkflowService, unknown>> = {
    list: vi.fn(async () => [makeHeader()]),
    createWorkflow: vi.fn(async () => ({ workflowId: WID, initialCoordNodeId: COORD_NID })),
    getWorkflow: vi.fn(async () => makeHeader()),
    getDag: vi.fn(async () => makeDag()),
    cancelWorkflow: vi.fn(async () => {}),
    ...overrides,
  };
  return stub as unknown as WorkflowService;
}

function stubTasks(
  overrides: Partial<{
    findTaskByWorkflowNode: (nodeId: string) => Promise<{ readonly id: string } | null>;
  }> = {},
) {
  return {
    findTaskByWorkflowNode: overrides.findTaskByWorkflowNode ?? (async () => null),
  } as unknown as import("@emploke/task").TaskService;
}

function mountRoutes(
  svc: WorkflowService,
  tasks: import("@emploke/task").TaskService = stubTasks(),
) {
  return workflowsRoutes(
    () => svc,
    () => tasks,
    () => "/tmp/test-workspace",
  );
}

// ─── GET / — list ────────────────────────────────────────────────────

describe("workflowsRoutes — list", () => {
  it("GET / returns the workflow list with iterationCount=0 per row", async () => {
    const svc = stubService({});
    const res = await mountRoutes(svc).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(WID);
    expect(body[0]?.iterationCount).toBe(0);
    expect(body[0]?.status).toBe("running");
    expect(svc.list).toHaveBeenCalledWith(undefined);
  });

  it("GET /?q=… forwards to substrate as idLike", async () => {
    const list = vi.fn(async () => []);
    const svc = stubService({ list });
    const res = await mountRoutes(svc).request("/?q=abc123");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ idLike: "abc123" });
  });

  it("GET /?coordinatorAgent=… forwards verbatim", async () => {
    const list = vi.fn(async () => []);
    const svc = stubService({ list });
    const res = await mountRoutes(svc).request("/?coordinatorAgent=agent-alpha");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ coordinatorAgent: "agent-alpha" });
  });

  it("GET /?createdSince=… forwards a parseable ISO timestamp", async () => {
    const list = vi.fn(async () => []);
    const svc = stubService({ list });
    const res = await mountRoutes(svc).request(
      `/?createdSince=${encodeURIComponent("2026-06-07T00:00:00.000Z")}`,
    );
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ createdSince: "2026-06-07T00:00:00.000Z" });
  });

  it("GET /?createdSince=bogus returns 400 and does NOT call the service", async () => {
    const svc = stubService({});
    const res = await mountRoutes(svc).request("/?createdSince=not-a-date");
    expect(res.status).toBe(400);
    expect(svc.list).not.toHaveBeenCalled();
  });

  it("GET / AND-combines q + coordinatorAgent + createdSince when all supplied", async () => {
    const list = vi.fn(async () => []);
    const svc = stubService({ list });
    const res = await mountRoutes(svc).request(
      `/?q=abc&coordinatorAgent=agent-alpha&createdSince=${encodeURIComponent("2026-06-07T00:00:00.000Z")}`,
    );
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      idLike: "abc",
      coordinatorAgent: "agent-alpha",
      createdSince: "2026-06-07T00:00:00.000Z",
    });
  });

  it("GET /?status=… is no longer recognised — slot is silently ignored", async () => {
    // v2.3 dropped the wire-side `?status=` slot in favour of
    // client-side Running/Completed grouping. Any caller still
    // passing it gets the unfiltered list, not a 400.
    const list = vi.fn(async () => []);
    const svc = stubService({ list });
    const res = await mountRoutes(svc).request("/?status=running");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(undefined);
  });
});

// ─── POST / — create ────────────────────────────────────────────────

describe("workflowsRoutes — create", () => {
  it("POST / creates and returns 201 with iterationCount=1", async () => {
    const svc = stubService({});
    const res = await mountRoutes(svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brief: "ship feature X",
        coordinatorAgent: "coord-agent",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(WID);
    expect(body.iterationCount).toBe(1);
    expect(svc.createWorkflow).toHaveBeenCalledWith({
      brief: "ship feature X",
      coordinatorAgent: "coord-agent",
    });
  });

  it("POST / forwards details + metadata when present", async () => {
    const createWorkflow = vi.fn(async () => ({ workflowId: WID, initialCoordNodeId: COORD_NID }));
    const svc = stubService({ createWorkflow });
    const res = await mountRoutes(svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brief: "ship feature X",
        details: "background prose",
        coordinatorAgent: "coord-agent",
        metadata: { priority: "high" },
      }),
    });
    expect(res.status).toBe(201);
    expect(createWorkflow).toHaveBeenCalledWith({
      brief: "ship feature X",
      coordinatorAgent: "coord-agent",
      details: "background prose",
      metadata: { priority: "high" },
    });
  });

  it("POST / with missing brief returns 400", async () => {
    const svc = stubService({});
    const res = await mountRoutes(svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordinatorAgent: "coord-agent" }),
    });
    expect(res.status).toBe(400);
    expect(svc.createWorkflow).not.toHaveBeenCalled();
  });

  it("POST / with unknown key returns 400", async () => {
    const svc = stubService({});
    const res = await mountRoutes(svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brief: "x",
        coordinatorAgent: "y",
        bogus: 1,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/bogus/);
  });

  it("POST / with non-object body returns 400", async () => {
    const svc = stubService({});
    const res = await mountRoutes(svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["hi"]),
    });
    expect(res.status).toBe(400);
  });
});

// ─── GET /:wfid — header ────────────────────────────────────────────

describe("workflowsRoutes — get", () => {
  it("GET /:wfid returns header with derived iterationCount=1 (1 coord node)", async () => {
    const svc = stubService({});
    const res = await mountRoutes(svc).request(`/${WID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(WID);
    // deriveIterationCount(coordNodes.length) — silent-retry coords
    // are counted too, so the seeded coord = iteration 1.
    expect(body.iterationCount).toBe(1);
  });

  it("GET /:wfid maps WorkflowNotFoundError to 404 with typed envelope", async () => {
    const svc = stubService({
      getDag: vi.fn(async () => {
        throw new WorkflowNotFoundError(WID);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowNotFoundError");
  });
});

// ─── GET /:wfid/dag — full snapshot ─────────────────────────────────

describe("workflowsRoutes — dag", () => {
  it("GET /:wfid/dag returns header + flat-spec nodes + edges", async () => {
    const svc = stubService({});
    const res = await mountRoutes(svc).request(`/${WID}/dag`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflow: Record<string, unknown>;
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    expect(body.workflow.id).toBe(WID);
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toEqual([{ from: COORD_NID, to: WORKER_NID }]);

    // Flat spec projection: coordinator → { kind: "coordinator", agent: ... }
    const coordNode = body.nodes.find((n) => n.id === COORD_NID);
    expect(coordNode?.spec).toEqual({ kind: "coordinator", agent: "coord-agent" });

    // Worker spec: kind "worker" → flat wire kind "task" with agent + brief
    const workerNode = body.nodes.find((n) => n.id === WORKER_NID);
    expect(workerNode?.spec).toEqual({ kind: "task", agent: "writer", brief: "draft" });
  });

  it("GET /:wfid/dag maps WorkflowNotFoundError to 404", async () => {
    const svc = stubService({
      getDag: vi.fn(async () => {
        throw new WorkflowNotFoundError(WID);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/dag`);
    expect(res.status).toBe(404);
  });

  it("GET /:wfid/dag enriches nodes with taskId via tasks resolver", async () => {
    const svc = stubService({});
    const findTaskByWorkflowNode = vi.fn(async (nodeId: string) => {
      if (nodeId === WORKER_NID) return { id: "20260607-aaaa1111" };
      return null;
    });
    const tasks = stubTasks({ findTaskByWorkflowNode });
    const res = await mountRoutes(svc, tasks).request(`/${WID}/dag`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<Record<string, unknown>> };
    const workerNode = body.nodes.find((n) => n.id === WORKER_NID);
    const coordNode = body.nodes.find((n) => n.id === COORD_NID);
    expect(workerNode?.taskId).toBe("20260607-aaaa1111");
    // null lookups omit the field entirely (no taskId: null on the wire).
    expect(coordNode).toBeDefined();
    expect("taskId" in (coordNode ?? {})).toBe(false);
    expect(findTaskByWorkflowNode).toHaveBeenCalledWith(WORKER_NID);
    expect(findTaskByWorkflowNode).toHaveBeenCalledWith(COORD_NID);
  });
});

// ─── POST /:wfid/cancel ─────────────────────────────────────────────

describe("workflowsRoutes — cancel", () => {
  it("POST /:wfid/cancel calls cancelWorkflow and returns the post-cancel header", async () => {
    const cancelWorkflow = vi.fn(async () => {});
    const cancelledDag: WorkflowDagSnapshot = {
      workflow: makeHeader({ status: "cancelled", endedAt: "2026-06-07T01:00:00.000Z" }),
      nodes: [makeCoord()],
      edges: [],
    };
    const getDag = vi.fn(async () => cancelledDag);
    const svc = stubService({ cancelWorkflow, getDag });
    const res = await mountRoutes(svc).request(`/${WID}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cancellation: { message: "operator stopped" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(WID);
    expect(body.status).toBe("cancelled");
    expect(body.endedAt).toBe("2026-06-07T01:00:00.000Z");
    expect(cancelWorkflow).toHaveBeenCalledWith({
      workflowId: WID,
      cancellation: { kind: "user", message: "operator stopped" },
    });
  });

  it("POST /:wfid/cancel maps WorkflowNotFoundError to 404", async () => {
    const svc = stubService({
      cancelWorkflow: vi.fn(async () => {
        throw new WorkflowNotFoundError(WID);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cancellation: { message: "" } }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /:wfid/cancel maps WorkflowAlreadyTerminalError to 409", async () => {
    const svc = stubService({
      cancelWorkflow: vi.fn(async () => {
        throw new WorkflowAlreadyTerminalError(WID);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cancellation: { message: "" } }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowAlreadyTerminalError");
  });

  it("POST /:wfid/cancel rejects the pre-v2.2 { reason } body shape with 400", async () => {
    const svc = stubService({ cancelWorkflow: vi.fn() });
    const res = await mountRoutes(svc).request(`/${WID}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "legacy" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /:wfid/cancel rejects missing cancellation with 400", async () => {
    const svc = stubService({ cancelWorkflow: vi.fn() });
    const res = await mountRoutes(svc).request(`/${WID}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─── M2.5 coord-callback mutation surface ───────────────────────────

const NEW_NID = "550e8400-e29b-41d4-a716-446655440099";
const MUTATION_DENIED_REASON = "no coord";

describe("workflowsRoutes — addNode (POST /:wfid/nodes)", () => {
  it("forwards body to substrate and returns AddNodeResult", async () => {
    const addNode = vi.fn(async () => ({ nodeId: NEW_NID, phase: 2 }));
    const svc = stubService({ addNode });
    const res = await mountRoutes(svc).request(`/${WID}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "worker",
        spec: { agent: "writer", brief: "do thing" },
        parents: [COORD_NID],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.nodeId).toBe(NEW_NID);
    expect(body.phase).toBe(2);
    expect(addNode).toHaveBeenCalledWith({
      workflowId: WID,
      kind: "worker",
      spec: { agent: "writer", brief: "do thing" },
      parents: [COORD_NID],
    });
  });

  it("rejects unknown kind with 400 and does not call the substrate", async () => {
    const addNode = vi.fn();
    const svc = stubService({ addNode });
    const res = await mountRoutes(svc).request(`/${WID}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "human", spec: {}, parents: [COORD_NID] }),
    });
    expect(res.status).toBe(400);
    expect(addNode).not.toHaveBeenCalled();
  });

  it("rejects missing parents with 400", async () => {
    const svc = stubService({ addNode: vi.fn() });
    const res = await mountRoutes(svc).request(`/${WID}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "worker", spec: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("maps WorkflowMutationUnauthorizedError to 403", async () => {
    const svc = stubService({
      addNode: vi.fn(async () => {
        throw new WorkflowMutationUnauthorizedError(WID, COORD_NID, MUTATION_DENIED_REASON);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "worker", spec: {}, parents: [COORD_NID] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowMutationUnauthorizedError");
  });

  it("maps WorkflowNotFoundError to 404", async () => {
    const svc = stubService({
      addNode: vi.fn(async () => {
        throw new WorkflowNotFoundError(WID);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "worker", spec: {}, parents: [COORD_NID] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("workflowsRoutes — addEdge (POST /:wfid/edges)", () => {
  it("forwards (fromNodeId, toNodeId) and echoes the pair on success", async () => {
    const addEdge = vi.fn(async () => ({ toPhase: 3 }));
    const svc = stubService({ addEdge });
    const res = await mountRoutes(svc).request(`/${WID}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromNodeId: COORD_NID, toNodeId: WORKER_NID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ fromNodeId: COORD_NID, toNodeId: WORKER_NID });
    expect(addEdge).toHaveBeenCalledWith({
      workflowId: WID,
      fromNodeId: COORD_NID,
      toNodeId: WORKER_NID,
    });
  });

  it("rejects missing toNodeId with 400", async () => {
    const svc = stubService({ addEdge: vi.fn() });
    const res = await mountRoutes(svc).request(`/${WID}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromNodeId: COORD_NID }),
    });
    expect(res.status).toBe(400);
  });

  it("maps WorkflowEdgeCycleError to 409", async () => {
    const svc = stubService({
      addEdge: vi.fn(async () => {
        throw new WorkflowEdgeCycleError(WID, COORD_NID, WORKER_NID);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromNodeId: COORD_NID, toNodeId: WORKER_NID }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowEdgeCycleError");
  });
});

describe("workflowsRoutes — addSubgraph (POST /:wfid/subgraph)", () => {
  it("translates wire NodeRefWire {nodeId} → substrate {kind:'existing'}", async () => {
    const addSubgraph = vi.fn(async () => ({
      insertedNodes: [{ tempId: "t1", nodeId: NEW_NID, phase: 2 }],
    }));
    const svc = stubService({ addSubgraph });
    const res = await mountRoutes(svc).request(`/${WID}/subgraph`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: [{ tempId: "t1", kind: "worker", spec: { agent: "writer" } }],
        edges: [{ from: { nodeId: COORD_NID }, to: { tempId: "t1" } }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { insertedNodes: Array<Record<string, unknown>> };
    expect(body.insertedNodes).toEqual([{ tempId: "t1", nodeId: NEW_NID, phase: 2 }]);
    expect(addSubgraph).toHaveBeenCalledWith({
      workflowId: WID,
      nodes: [{ tempId: "t1", kind: "worker", spec: { agent: "writer" } }],
      edges: [
        {
          from: { kind: "existing", id: COORD_NID },
          to: { kind: "temp", tempId: "t1" },
        },
      ],
    });
  });

  it("translates wire NodeRefWire {tempId} → substrate {kind:'temp'} on both arms", async () => {
    const addSubgraph = vi.fn(async () => ({
      insertedNodes: [
        { tempId: "t1", nodeId: "n1", phase: 2 },
        { tempId: "t2", nodeId: "n2", phase: 3 },
      ],
    }));
    const svc = stubService({ addSubgraph });
    const res = await mountRoutes(svc).request(`/${WID}/subgraph`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: [
          { tempId: "t1", kind: "worker", spec: {}, existingParents: [COORD_NID] },
          { tempId: "t2", kind: "worker", spec: {} },
        ],
        edges: [{ from: { tempId: "t1" }, to: { tempId: "t2" } }],
      }),
    });
    expect(res.status).toBe(200);
    expect(addSubgraph).toHaveBeenCalledWith({
      workflowId: WID,
      nodes: [
        { tempId: "t1", kind: "worker", spec: {}, existingParents: [COORD_NID] },
        { tempId: "t2", kind: "worker", spec: {} },
      ],
      edges: [
        {
          from: { kind: "temp", tempId: "t1" },
          to: { kind: "temp", tempId: "t2" },
        },
      ],
    });
  });

  it("rejects an edge with both nodeId and tempId on one arm with 400", async () => {
    const svc = stubService({ addSubgraph: vi.fn() });
    const res = await mountRoutes(svc).request(`/${WID}/subgraph`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: [{ tempId: "t1", kind: "worker", spec: {} }],
        edges: [{ from: { nodeId: COORD_NID, tempId: "t1" }, to: { tempId: "t1" } }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("workflowsRoutes — cancelNode (POST /:wfid/nodes/:nid/cancel)", () => {
  it("forwards (workflowId, nodeId) and projects the post-cancel node", async () => {
    const cancelNode = vi.fn(async () => {});
    const cancelledWorker = WorkflowNodeEntity.fromRow({
      id: WORKER_NID,
      workflowId: WID,
      kind: "worker",
      specJson: JSON.stringify({ agent: "writer", brief: "draft" }),
      phase: 1,
      status: "cancelled",
      createdAt: "2026-06-07T00:00:01.000Z",
      readyAt: "2026-06-07T00:00:02.000Z",
      runningAt: "2026-06-07T00:00:03.000Z",
      endedAt: "2026-06-07T00:00:04.000Z",
    });
    const svc = stubService({
      cancelNode,
      getNode: vi.fn(async () => cancelledWorker),
    });
    const res = await mountRoutes(svc).request(`/${WID}/nodes/${WORKER_NID}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(WORKER_NID);
    expect(body.status).toBe("cancelled");
    expect(body.endedAt).toBe("2026-06-07T00:00:04.000Z");
    expect(cancelNode).toHaveBeenCalledWith({ workflowId: WID, nodeId: WORKER_NID });
  });

  it("maps WorkflowNodeNotMutableError to 409 (coord-kind target)", async () => {
    const svc = stubService({
      cancelNode: vi.fn(async () => {
        throw new WorkflowNodeNotMutableError(WID, COORD_NID, "running", "cancelNode");
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/nodes/${COORD_NID}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowNodeNotMutableError");
  });
});

describe("workflowsRoutes — finish (POST /:wfid/finish)", () => {
  it("forwards outcome and returns post-finish header", async () => {
    const finishWorkflow = vi.fn(async () => {});
    const succeededDag: WorkflowDagSnapshot = {
      workflow: makeHeader({ status: "succeeded", endedAt: "2026-06-07T01:00:00.000Z" }),
      nodes: [makeCoord()],
      edges: [],
    };
    const svc = stubService({
      finishWorkflow,
      getDag: vi.fn(async () => succeededDag),
    });
    const res = await mountRoutes(svc).request(`/${WID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "succeeded", success: { output: "all good" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("succeeded");
    expect(body.endedAt).toBe("2026-06-07T01:00:00.000Z");
    expect(finishWorkflow).toHaveBeenCalledWith({
      workflowId: WID,
      outcome: "succeeded",
      success: { output: "all good" },
    });
  });

  it("defaults success.output to null when outcome='succeeded' and success is omitted", async () => {
    const finishWorkflow = vi.fn(async () => {});
    const succeededDag: WorkflowDagSnapshot = {
      workflow: makeHeader({ status: "succeeded", endedAt: "2026-06-07T01:00:00.000Z" }),
      nodes: [makeCoord()],
      edges: [],
    };
    const svc = stubService({
      finishWorkflow,
      getDag: vi.fn(async () => succeededDag),
    });
    const res = await mountRoutes(svc).request(`/${WID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "succeeded" }),
    });
    expect(res.status).toBe(200);
    expect(finishWorkflow).toHaveBeenCalledWith({
      workflowId: WID,
      outcome: "succeeded",
      success: { output: null },
    });
  });

  it("rejects outcome='cancelled' with 400", async () => {
    const svc = stubService({ finishWorkflow: vi.fn() });
    const res = await mountRoutes(svc).request(`/${WID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "cancelled" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects outcome='failed' without failure with 400", async () => {
    const svc = stubService({ finishWorkflow: vi.fn() });
    const res = await mountRoutes(svc).request(`/${WID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "failed" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts outcome='failed' with failure.message", async () => {
    const finishWorkflow = vi.fn(async () => {});
    const failedDag: WorkflowDagSnapshot = {
      workflow: makeHeader({ status: "failed", endedAt: "2026-06-07T01:00:00.000Z" }),
      nodes: [makeCoord()],
      edges: [],
    };
    const svc = stubService({
      finishWorkflow,
      getDag: vi.fn(async () => failedDag),
    });
    const res = await mountRoutes(svc).request(`/${WID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "failed", failure: { message: "budget out" } }),
    });
    expect(res.status).toBe(200);
    expect(finishWorkflow).toHaveBeenCalledWith({
      workflowId: WID,
      outcome: "failed",
      failure: { kind: "coord", message: "budget out" },
    });
  });

  it("maps WorkflowMutationUnauthorizedError to 403", async () => {
    const svc = stubService({
      finishWorkflow: vi.fn(async () => {
        throw new WorkflowMutationUnauthorizedError(WID, COORD_NID, MUTATION_DENIED_REASON);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "failed", failure: { message: "x" } }),
    });
    expect(res.status).toBe(403);
  });
});

describe("workflowsRoutes — removeNode (DELETE /:wfid/nodes/:nid)", () => {
  it("forwards (workflowId, nodeId) and returns 204 No Content on success", async () => {
    const removeNode = vi.fn(async () => {});
    const svc = stubService({ removeNode });
    const res = await mountRoutes(svc).request(`/${WID}/nodes/${WORKER_NID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(removeNode).toHaveBeenCalledWith({ workflowId: WID, nodeId: WORKER_NID });
  });

  it("maps WorkflowRemoveNodeOrphansChildError to 409", async () => {
    const svc = stubService({
      removeNode: vi.fn(async () => {
        throw new WorkflowRemoveNodeOrphansChildError(WID, WORKER_NID, "child-id");
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/nodes/${WORKER_NID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowRemoveNodeOrphansChildError");
  });
});

describe("workflowsRoutes — removeEdge (DELETE /:wfid/edges/:from/:to)", () => {
  it("forwards (workflowId, from, to) and returns 204 on success", async () => {
    const removeEdge = vi.fn(async () => {});
    const svc = stubService({ removeEdge });
    const res = await mountRoutes(svc).request(`/${WID}/edges/${COORD_NID}/${WORKER_NID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(removeEdge).toHaveBeenCalledWith({
      workflowId: WID,
      fromNodeId: COORD_NID,
      toNodeId: WORKER_NID,
    });
  });

  it("maps WorkflowNotFoundError to 404", async () => {
    const svc = stubService({
      removeEdge: vi.fn(async () => {
        throw new WorkflowNotFoundError(WID);
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/edges/${COORD_NID}/${WORKER_NID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("workflowsRoutes — replaceNodeSpec (PATCH /:wfid/nodes/:nid/spec)", () => {
  it("forwards (workflowId, nodeId, newSpec) and projects the post-update node", async () => {
    const replaceNodeSpec = vi.fn(async () => {});
    const updatedWorker = WorkflowNodeEntity.fromRow({
      id: WORKER_NID,
      workflowId: WID,
      kind: "worker",
      specJson: JSON.stringify({ agent: "writer", brief: "revised" }),
      phase: 1,
      status: "not_started",
      createdAt: "2026-06-07T00:00:01.000Z",
      readyAt: null,
      runningAt: null,
      endedAt: null,
    });
    const svc = stubService({
      replaceNodeSpec,
      getNode: vi.fn(async () => updatedWorker),
    });
    const res = await mountRoutes(svc).request(`/${WID}/nodes/${WORKER_NID}/spec`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newSpec: { agent: "writer", brief: "revised" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({ kind: "task", agent: "writer", brief: "revised" });
    expect(replaceNodeSpec).toHaveBeenCalledWith({
      workflowId: WID,
      nodeId: WORKER_NID,
      newSpec: { agent: "writer", brief: "revised" },
    });
  });

  it("rejects body missing newSpec with 400", async () => {
    const svc = stubService({ replaceNodeSpec: vi.fn() });
    const res = await mountRoutes(svc).request(`/${WID}/nodes/${WORKER_NID}/spec`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("maps WorkflowNodeNotMutableError to 409 (running node)", async () => {
    const svc = stubService({
      replaceNodeSpec: vi.fn(async () => {
        throw new WorkflowNodeNotMutableError(WID, WORKER_NID, "running", "replaceNodeSpec");
      }),
    });
    const res = await mountRoutes(svc).request(`/${WID}/nodes/${WORKER_NID}/spec`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newSpec: {} }),
    });
    expect(res.status).toBe(409);
  });
});

/**
 * Route-level tests for `routes/workflows.ts`. Sibling of
 * `schedules.test.ts` — same stub-service pattern, same vitest
 * layout. Covers the 5-verb surface: list, create, get, dag, cancel.
 *
 * Assertion surface:
 *   - happy-path passthrough to the injected `WorkflowService` stub
 *   - input validation 400s (status query, create body shape)
 *   - 404 mapping for `WorkflowNotFoundError`
 *   - 409 mapping for `WorkflowAlreadyTerminalError`
 *   - wire-shape projection (flat per-kind node specs, ISO timestamps
 *     forwarded verbatim)
 *   - `iterationCount` derivation: 0 on list, coord-count-based on
 *     show / dag
 *   - cancel response is the post-cancel header (second getDag)
 */

import type { WorkflowDagSnapshot } from "@emploke/workflow";
import {
  WorkflowAlreadyTerminalError,
  WorkflowEdgeEntity,
  WorkflowEntity,
  WorkflowNodeEntity,
  WorkflowNotFoundError,
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

// ─── GET / — list ────────────────────────────────────────────────────

describe("workflowsRoutes — list", () => {
  it("GET / returns the workflow list with iterationCount=0 per row", async () => {
    const svc = stubService({});
    const res = await workflowsRoutes(() => svc).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(WID);
    expect(body[0]?.iterationCount).toBe(0);
    expect(body[0]?.status).toBe("running");
    expect(svc.list).toHaveBeenCalledWith(undefined);
  });

  it("GET /?status=running narrows the list opts", async () => {
    const list = vi.fn(async () => []);
    const svc = stubService({ list });
    const res = await workflowsRoutes(() => svc).request("/?status=running");
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ status: "running" });
  });

  it("GET /?status=bogus returns 400 and does NOT call the service", async () => {
    const svc = stubService({});
    const res = await workflowsRoutes(() => svc).request("/?status=bogus");
    expect(res.status).toBe(400);
    expect(svc.list).not.toHaveBeenCalled();
  });
});

// ─── POST / — create ────────────────────────────────────────────────

describe("workflowsRoutes — create", () => {
  it("POST / creates and returns 201 with iterationCount=1", async () => {
    const svc = stubService({});
    const res = await workflowsRoutes(() => svc).request("/", {
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
    const res = await workflowsRoutes(() => svc).request("/", {
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
    const res = await workflowsRoutes(() => svc).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordinatorAgent: "coord-agent" }),
    });
    expect(res.status).toBe(400);
    expect(svc.createWorkflow).not.toHaveBeenCalled();
  });

  it("POST / with unknown key returns 400", async () => {
    const svc = stubService({});
    const res = await workflowsRoutes(() => svc).request("/", {
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
    const res = await workflowsRoutes(() => svc).request("/", {
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
    const res = await workflowsRoutes(() => svc).request(`/${WID}`);
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
    const res = await workflowsRoutes(() => svc).request(`/${WID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowNotFoundError");
  });
});

// ─── GET /:wfid/dag — full snapshot ─────────────────────────────────

describe("workflowsRoutes — dag", () => {
  it("GET /:wfid/dag returns header + flat-spec nodes + edges", async () => {
    const svc = stubService({});
    const res = await workflowsRoutes(() => svc).request(`/${WID}/dag`);
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
    const res = await workflowsRoutes(() => svc).request(`/${WID}/dag`);
    expect(res.status).toBe(404);
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
    const res = await workflowsRoutes(() => svc).request(`/${WID}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(WID);
    expect(body.status).toBe("cancelled");
    expect(body.endedAt).toBe("2026-06-07T01:00:00.000Z");
    expect(cancelWorkflow).toHaveBeenCalledWith({ workflowId: WID });
  });

  it("POST /:wfid/cancel maps WorkflowNotFoundError to 404", async () => {
    const svc = stubService({
      cancelWorkflow: vi.fn(async () => {
        throw new WorkflowNotFoundError(WID);
      }),
    });
    const res = await workflowsRoutes(() => svc).request(`/${WID}/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /:wfid/cancel maps WorkflowAlreadyTerminalError to 409", async () => {
    const svc = stubService({
      cancelWorkflow: vi.fn(async () => {
        throw new WorkflowAlreadyTerminalError(WID);
      }),
    });
    const res = await workflowsRoutes(() => svc).request(`/${WID}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("WorkflowAlreadyTerminalError");
  });
});

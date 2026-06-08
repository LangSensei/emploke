import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidWorkflowIdError, InvalidWorkflowNodeIdError } from "../src/errors.js";
import { openTestWorkflowDb } from "../src/testing.js";
import { WorkflowEdgeEntity, WorkflowEntity, WorkflowNodeEntity } from "../src/workflow-entity.js";
import { WorkflowRepository } from "../src/workflow-repository.js";

const NOW = "2026-06-07T00:00:00.000Z";
const WF_ID = "550e8400-e29b-41d4-a716-446655440000";
const COORD_ID = "550e8400-e29b-41d4-a716-446655440001";
const WORKER_ID = "550e8400-e29b-41d4-a716-446655440002";

function makeWf(over?: Partial<{ status: string; coordinatorAgent: string }>): WorkflowEntity {
  const status = over?.status ?? "running";
  // v2.2: terminal rows carry a JSON payload column for the matching
  // status. Tests synthesising terminal rows have to supply one so
  // the cross-field invariant in `WorkflowEntity.fromRow` is met.
  // Running rows leave all three columns null. The repository tests
  // here exercise repo CRUD against `running` rows, so the inserted
  // shape stays minimal; status-flips inside test bodies use
  // `casUpdateWorkflowStatus` directly.
  return WorkflowEntity.fromRow({
    id: WF_ID,
    brief: "brief",
    details: null,
    coordinatorAgent: over?.coordinatorAgent ?? "agent-1",
    status,
    metadata: "{}",
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    success: status === "succeeded" ? JSON.stringify({ output: null }) : null,
    failure: status === "failed" ? JSON.stringify({ kind: "coord", message: "" }) : null,
    cancellation: status === "cancelled" ? JSON.stringify({ kind: "user", message: "" }) : null,
  });
}

function makeNode(
  over?: Partial<{
    id: string;
    workflowId: string;
    kind: string;
    status: string;
    phase: number;
    spec: unknown;
  }>,
): WorkflowNodeEntity {
  return WorkflowNodeEntity.fromRow({
    id: over?.id ?? COORD_ID,
    workflowId: over?.workflowId ?? WF_ID,
    kind: over?.kind ?? "coordinator",
    specJson: JSON.stringify(over?.spec ?? { agent: "agent-1" }),
    phase: over?.phase ?? 0,
    status: over?.status ?? "not_started",
    createdAt: NOW,
    readyAt: null,
    runningAt: null,
    endedAt: null,
  });
}

describe("WorkflowRepository — CRUD round-trips", () => {
  let db: ReturnType<typeof openTestWorkflowDb>;
  let repo: WorkflowRepository;

  beforeEach(() => {
    db = openTestWorkflowDb();
    repo = new WorkflowRepository({ db: db.db });
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and reads back a workflow row", async () => {
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
    });
    const wf = await repo.readWorkflow(WF_ID);
    expect(wf).not.toBeNull();
    expect(wf?.id).toBe(WF_ID);
    expect(wf?.status).toBe("running");
    expect(wf?.coordinatorAgent).toBe("agent-1");
  });

  it("returns null for a missing workflow id", async () => {
    const wf = await repo.readWorkflow(WF_ID);
    expect(wf).toBeNull();
  });

  it("inserts and lists workflow nodes by workflow id", async () => {
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID, kind: "coordinator" }));
      repo.insertNode(tx, makeNode({ id: WORKER_ID, kind: "worker", phase: 1 }));
    });
    const nodes = await repo.listNodesByWorkflow(WF_ID);
    expect(nodes).toHaveLength(2);
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual([COORD_ID, WORKER_ID].sort());
  });

  it("CAS-updates workflow status only when the from-status matches", () => {
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
    });
    const okFirst = db.db.transaction((tx) =>
      repo.casUpdateWorkflowStatus(tx, {
        id: WF_ID,
        fromStatus: "running",
        toStatus: "succeeded",
        endedAt: NOW,
      }),
    );
    expect(okFirst).toBe(true);
    // A second attempt finds status='succeeded' (not 'running') and
    // affects 0 rows; CAS returns false. This is the once-only
    // termination guarantee the service relies on.
    const okSecond = db.db.transaction((tx) =>
      repo.casUpdateWorkflowStatus(tx, {
        id: WF_ID,
        fromStatus: "running",
        toStatus: "failed",
        endedAt: NOW,
      }),
    );
    expect(okSecond).toBe(false);
  });

  it("updateNodeLifecycle updates the requested fields and leaves others intact", async () => {
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode());
    });
    db.db.transaction((tx) => {
      repo.updateNodeLifecycle(tx, {
        id: COORD_ID,
        status: "running",
        runningAt: NOW,
      });
    });
    const node = await repo.readNode(COORD_ID);
    expect(node?.status).toBe("running");
    expect(node?.runningAt).toBe(NOW);
    expect(node?.endedAt).toBeUndefined();
  });

  it("updateNodePhases bulk-updates phase only", async () => {
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID, phase: 0 }));
      repo.insertNode(tx, makeNode({ id: WORKER_ID, kind: "worker", phase: 1 }));
    });
    db.db.transaction((tx) => {
      const diff = new Map<string, number>();
      diff.set(COORD_ID, 2);
      diff.set(WORKER_ID, 3);
      repo.updateNodePhases(tx, diff);
    });
    const a = await repo.readNode(COORD_ID);
    const b = await repo.readNode(WORKER_ID);
    expect(a?.phase).toBe(2);
    expect(b?.phase).toBe(3);
  });

  it("insertEdge + listEdgesByWorkflow round-trips a DAG edge", async () => {
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID }));
      repo.insertNode(tx, makeNode({ id: WORKER_ID, kind: "worker", phase: 1 }));
      repo.insertEdge(tx, { workflowId: WF_ID, from: COORD_ID, to: WORKER_ID });
    });
    const edges = await repo.listEdgesByWorkflow(WF_ID);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toBeInstanceOf(WorkflowEdgeEntity);
    expect(edges[0]?.from).toBe(COORD_ID);
    expect(edges[0]?.to).toBe(WORKER_ID);
  });

  it("readCallerCoordContext returns the JOIN row when both sides exist", () => {
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID, status: "running" }));
    });
    const ctx = db.db.transaction((tx) => repo.readCallerCoordContext(tx, COORD_ID));
    expect(ctx).not.toBeNull();
    expect(ctx?.callerKind).toBe("coordinator");
    expect(ctx?.callerStatus).toBe("running");
    expect(ctx?.workflowStatus).toBe("running");
    expect(ctx?.callerWorkflowId).toBe(WF_ID);
    expect(JSON.parse(ctx?.callerSpecJson ?? "{}")).toEqual({ agent: "agent-1" });
  });

  it("readCallerCoordContext returns null when caller node is absent", () => {
    const ctx = db.db.transaction((tx) => repo.readCallerCoordContext(tx, COORD_ID));
    expect(ctx).toBeNull();
  });

  it("readRunningCoordsForWorkflow returns an empty list when no coord is running", () => {
    // 0-row branch — exercised by `deriveCallerCoord` to reject
    // ordinary mutations during the handover window (or when the
    // workflow is terminal).
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID, status: "succeeded" }));
    });
    const rows = db.db.transaction((tx) => repo.readRunningCoordsForWorkflow(tx, WF_ID));
    expect(rows).toEqual([]);
  });

  it("readRunningCoordsForWorkflow returns the single running coord (happy path)", () => {
    // 1-row branch — the substrate parses `specJson` and returns
    // `{id, spec}` to the caller.
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID, status: "running" }));
    });
    const rows = db.db.transaction((tx) => repo.readRunningCoordsForWorkflow(tx, WF_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(COORD_ID);
    expect(JSON.parse(rows[0]?.specJson ?? "{}")).toEqual({ agent: "agent-1" });
  });

  it("readRunningCoordsForWorkflow caps the result at 2 rows (LIMIT 2) for invariant-#2 detection", () => {
    // 2+ branch — `deriveCallerCoord` only needs to know "≥ 2", so
    // the LIMIT 2 keeps the SELECT bounded even if a future
    // corruption ever produced many running coords.
    const SECOND_COORD = "550e8400-e29b-41d4-a716-446655440099";
    const THIRD_COORD = "550e8400-e29b-41d4-a716-44665544009a";
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID, status: "running" }));
      repo.insertNode(tx, makeNode({ id: SECOND_COORD, status: "running" }));
      repo.insertNode(tx, makeNode({ id: THIRD_COORD, status: "running" }));
    });
    const rows = db.db.transaction((tx) => repo.readRunningCoordsForWorkflow(tx, WF_ID));
    expect(rows).toHaveLength(2);
  });

  it("readRunningCoordsForWorkflow ignores worker-kind running rows", () => {
    // Only `kind = 'coordinator'` rows are considered; running
    // workers must NOT be counted toward the invariant-#2 check.
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID, status: "running" }));
      repo.insertNode(
        tx,
        makeNode({
          id: WORKER_ID,
          kind: "worker",
          phase: 1,
          status: "running",
        }),
      );
    });
    const rows = db.db.transaction((tx) => repo.readRunningCoordsForWorkflow(tx, WF_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(COORD_ID);
  });

  it("listNonTerminalNodes filters to {not_started, ready, running}", () => {
    db.db.transaction((tx) => {
      repo.insertWorkflow(tx, makeWf());
      repo.insertNode(tx, makeNode({ id: COORD_ID, status: "running" }));
      repo.insertNode(
        tx,
        makeNode({ id: WORKER_ID, kind: "worker", phase: 1, status: "succeeded" }),
      );
      repo.insertNode(
        tx,
        makeNode({
          id: "550e8400-e29b-41d4-a716-446655440003",
          kind: "worker",
          phase: 1,
          status: "not_started",
        }),
      );
    });
    const live = db.db.transaction((tx) => repo.listNonTerminalNodes(tx, WF_ID));
    expect(live.map((n) => n.id).sort()).toEqual(
      [COORD_ID, "550e8400-e29b-41d4-a716-446655440003"].sort(),
    );
  });
});

describe("WorkflowRepository — defense-in-depth id validation", () => {
  let db: ReturnType<typeof openTestWorkflowDb>;
  let repo: WorkflowRepository;

  beforeEach(() => {
    db = openTestWorkflowDb();
    repo = new WorkflowRepository({ db: db.db });
  });

  afterEach(() => {
    db.close();
  });

  it("readWorkflow rejects an id that fails grammar", async () => {
    await expect(repo.readWorkflow("not-a-uuid")).rejects.toBeInstanceOf(InvalidWorkflowIdError);
  });

  it("readNode rejects an id that fails grammar", async () => {
    await expect(repo.readNode("not-a-uuid")).rejects.toBeInstanceOf(InvalidWorkflowNodeIdError);
  });

  it("listNodesByWorkflow rejects an invalid workflow id", async () => {
    await expect(repo.listNodesByWorkflow("not-a-uuid")).rejects.toBeInstanceOf(
      InvalidWorkflowIdError,
    );
  });

  it("listEdgesByWorkflow rejects an invalid workflow id", async () => {
    await expect(repo.listEdgesByWorkflow("not-a-uuid")).rejects.toBeInstanceOf(
      InvalidWorkflowIdError,
    );
  });
});

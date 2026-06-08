/**
 * Unit tests for the coordinator-kind {@link WorkflowNodeRunner}
 * exported by `packages/api/src/wiring/workflow-coord-runner.ts`.
 *
 * Coverage traces:
 *   - `validate` shape rules (U1–U5)
 *   - `dispatch` step ① fan-out (U6)
 *   - `dispatch` step ② outcome mapping for the three terminal
 *     worker statuses (U7/U8/U9)
 *   - `dispatch` defensive branch on unexpected coord counts (U10)
 *   - the two-phase init diagnostic (U11)
 *   - `hasInFlightForNode` / `cancel` invariants (U12/U13)
 *
 * Tests mock `WorkflowService` end-to-end: there is no DB or engine
 * here. The DAG snapshot is hand-rolled and cast via `unknown` so
 * tests stay focused on the runner's branching, not on the entity
 * layer (which is exercised end-to-end in the integration test).
 */

import type {
  WorkflowDagSnapshot,
  WorkflowEdgeEntity,
  WorkflowNodeEntity,
  WorkflowNodeTerminalResult,
  WorkflowNodeValidateCtx,
  WorkflowService,
} from "@emploke/workflow";
import { WorkflowNodeSpecError } from "@emploke/workflow";
import { describe, expect, it, vi } from "vitest";
import {
  makeWorkflowStubCoordRunner,
  WORKFLOW_STUB_WORKER_AGENT,
  WORKFLOW_STUB_WORKER_BRIEF,
} from "../src/wiring/workflow-coord-runner.js";

const WORKFLOW_ID = "550e8400-e29b-41d4-a716-446655440000";
const INITIAL_COORD_ID = "550e8400-e29b-41d4-a716-446655440001";
const WORKER_ID = "550e8400-e29b-41d4-a716-446655440002";
const FOLLOW_UP_COORD_ID = "550e8400-e29b-41d4-a716-446655440003";
const COORD_AGENT = "test-coord-agent";

interface MockNode {
  readonly id: string;
  readonly kind: "coordinator" | "worker";
  readonly status: "not_started" | "ready" | "running" | "succeeded" | "failed" | "cancelled";
}

interface MockEdge {
  readonly from: string;
  readonly to: string;
}

function dagFor(nodes: readonly MockNode[], edges: readonly MockEdge[]): WorkflowDagSnapshot {
  return {
    workflow: {} as unknown as WorkflowDagSnapshot["workflow"],
    nodes: nodes as unknown as readonly WorkflowNodeEntity[],
    edges: edges as unknown as readonly WorkflowEdgeEntity[],
  };
}

function validateCtx(): WorkflowNodeValidateCtx {
  return {
    workflowId: WORKFLOW_ID,
    callerCoordNodeId: INITIAL_COORD_ID,
    callerCoordSpec: { agent: COORD_AGENT },
    workflowStatus: "running",
  };
}

/**
 * Build a partial WorkflowService mock plus a per-test call log that
 * records `addNode` / `finishWorkflow` / `getDag` invocations in
 * order. Tests assert against the log to verify dispatch ordering.
 */
function makeMockService(opts: {
  readonly dag: WorkflowDagSnapshot;
  readonly addNodeReturnIds?: readonly string[];
  readonly addNodeThrows?: Error;
}): {
  readonly service: WorkflowService;
  readonly callLog: string[];
  readonly addNodeMock: ReturnType<typeof vi.fn>;
  readonly finishWorkflowMock: ReturnType<typeof vi.fn>;
  readonly getDagMock: ReturnType<typeof vi.fn>;
} {
  const callLog: string[] = [];
  let addNodeSeq = 0;
  const returnIds = opts.addNodeReturnIds ?? [WORKER_ID, FOLLOW_UP_COORD_ID];

  const addNodeMock = vi.fn(async (args: { readonly kind: string }) => {
    callLog.push(`addNode:${args.kind}`);
    if (opts.addNodeThrows !== undefined) throw opts.addNodeThrows;
    const id = returnIds[addNodeSeq];
    addNodeSeq += 1;
    if (id === undefined) {
      throw new Error("mock service: ran out of addNodeReturnIds");
    }
    return { nodeId: id, phase: 1 };
  });
  const finishWorkflowMock = vi.fn(async (args: { readonly outcome: string }) => {
    callLog.push(`finishWorkflow:${args.outcome}`);
  });
  const getDagMock = vi.fn(async () => {
    callLog.push("getDag");
    return opts.dag;
  });

  const service = {
    addNode: addNodeMock,
    finishWorkflow: finishWorkflowMock,
    getDag: getDagMock,
  } as unknown as WorkflowService;

  return { service, callLog, addNodeMock, finishWorkflowMock, getDagMock };
}

describe("@emploke/api workflow-coord-runner — validate (U1–U5)", () => {
  const runner = makeWorkflowStubCoordRunner({
    getService: () => ({}) as unknown as WorkflowService,
  });

  it("U1 — validate({agent:'x'}) returns {agent:'x'}", async () => {
    const out = await runner.validate({ agent: "x" }, validateCtx());
    expect(out).toEqual({ agent: "x" });
  });

  it("U2 — validate({agent:''}) throws WorkflowNodeSpecError", async () => {
    await expect(runner.validate({ agent: "" }, validateCtx())).rejects.toBeInstanceOf(
      WorkflowNodeSpecError,
    );
    await expect(runner.validate({ agent: "   " }, validateCtx())).rejects.toBeInstanceOf(
      WorkflowNodeSpecError,
    );
  });

  it("U3 — validate({foo:'bar'}) (missing agent) throws WorkflowNodeSpecError", async () => {
    await expect(runner.validate({ foo: "bar" }, validateCtx())).rejects.toBeInstanceOf(
      WorkflowNodeSpecError,
    );
  });

  it("U4 — validate(null) throws WorkflowNodeSpecError", async () => {
    await expect(runner.validate(null, validateCtx())).rejects.toBeInstanceOf(
      WorkflowNodeSpecError,
    );
    await expect(runner.validate("string", validateCtx())).rejects.toBeInstanceOf(
      WorkflowNodeSpecError,
    );
    await expect(runner.validate(42, validateCtx())).rejects.toBeInstanceOf(WorkflowNodeSpecError);
    await expect(runner.validate([], validateCtx())).rejects.toBeInstanceOf(WorkflowNodeSpecError);
  });

  it("U5 — validate({agent:'x', extra:1}) throws (strict shape)", async () => {
    await expect(runner.validate({ agent: "x", extra: 1 }, validateCtx())).rejects.toBeInstanceOf(
      WorkflowNodeSpecError,
    );
  });
});

describe("@emploke/api workflow-coord-runner — dispatch step ① (U6)", () => {
  it("U6 — step ① calls addNode(worker) → addNode(coord) → onTerminal(succeeded) in order", async () => {
    const dag = dagFor([{ id: INITIAL_COORD_ID, kind: "coordinator", status: "running" }], []);
    const { service, callLog, addNodeMock } = makeMockService({ dag });
    const onTerminalCalls: WorkflowNodeTerminalResult[] = [];
    const runner = makeWorkflowStubCoordRunner({ getService: () => service });

    const result = await runner.dispatch({
      workflowId: WORKFLOW_ID,
      nodeId: INITIAL_COORD_ID,
      spec: { agent: COORD_AGENT },
      nodeDir: "/tmp/nodedir",
      onTerminal: (r) => {
        callLog.push(`onTerminal:${r.status}`);
        onTerminalCalls.push(r);
      },
    });

    expect(callLog).toEqual([
      "getDag",
      "addNode:worker",
      "addNode:coordinator",
      "onTerminal:succeeded",
    ]);
    expect(addNodeMock).toHaveBeenCalledTimes(2);
    expect(addNodeMock.mock.calls[0]?.[0]).toEqual({
      workflowId: WORKFLOW_ID,
      kind: "worker",
      spec: {
        agent: WORKFLOW_STUB_WORKER_AGENT,
        brief: WORKFLOW_STUB_WORKER_BRIEF,
      },
      parents: [INITIAL_COORD_ID],
    });
    expect(addNodeMock.mock.calls[1]?.[0]).toEqual({
      workflowId: WORKFLOW_ID,
      kind: "coordinator",
      spec: { agent: COORD_AGENT },
      parents: [INITIAL_COORD_ID, WORKER_ID],
    });
    expect(onTerminalCalls).toEqual([{ status: "succeeded" }]);
    expect(result.unitId).toBe(`stub-coord-init:${INITIAL_COORD_ID}`);
  });

  it("substrate safety net — addNode-throws bubbles up so the substrate marks the node failed (see workflow-service.ts:1685-1702)", async () => {
    const dag = dagFor([{ id: INITIAL_COORD_ID, kind: "coordinator", status: "running" }], []);
    const boom = new Error("simulated addNode failure");
    const { service } = makeMockService({ dag, addNodeThrows: boom });
    const runner = makeWorkflowStubCoordRunner({ getService: () => service });

    await expect(
      runner.dispatch({
        workflowId: WORKFLOW_ID,
        nodeId: INITIAL_COORD_ID,
        spec: { agent: COORD_AGENT },
        nodeDir: "/tmp/nodedir",
        onTerminal: () => {
          /* unused */
        },
      }),
    ).rejects.toBe(boom);
  });
});

describe("@emploke/api workflow-coord-runner — dispatch step ② (U7/U8/U9)", () => {
  function step2Dag(workerStatus: MockNode["status"]): WorkflowDagSnapshot {
    return dagFor(
      [
        { id: INITIAL_COORD_ID, kind: "coordinator", status: "succeeded" },
        { id: WORKER_ID, kind: "worker", status: workerStatus },
        { id: FOLLOW_UP_COORD_ID, kind: "coordinator", status: "running" },
      ],
      [
        { from: INITIAL_COORD_ID, to: WORKER_ID },
        { from: INITIAL_COORD_ID, to: FOLLOW_UP_COORD_ID },
        { from: WORKER_ID, to: FOLLOW_UP_COORD_ID },
      ],
    );
  }

  async function runStep2(workerStatus: MockNode["status"]): Promise<{
    callLog: string[];
    onTerminalCalls: WorkflowNodeTerminalResult[];
    unitId: string;
  }> {
    const { service, callLog } = makeMockService({ dag: step2Dag(workerStatus) });
    const onTerminalCalls: WorkflowNodeTerminalResult[] = [];
    const runner = makeWorkflowStubCoordRunner({ getService: () => service });
    const result = await runner.dispatch({
      workflowId: WORKFLOW_ID,
      nodeId: FOLLOW_UP_COORD_ID,
      spec: { agent: COORD_AGENT },
      nodeDir: "/tmp/nodedir",
      onTerminal: (r) => {
        callLog.push(`onTerminal:${r.status}`);
        onTerminalCalls.push(r);
      },
    });
    return { callLog, onTerminalCalls, unitId: result.unitId };
  }

  it("U7 — worker.succeeded → finishWorkflow(succeeded) then onTerminal(succeeded)", async () => {
    const { callLog, onTerminalCalls, unitId } = await runStep2("succeeded");
    expect(callLog).toEqual(["getDag", "finishWorkflow:succeeded", "onTerminal:succeeded"]);
    expect(onTerminalCalls).toEqual([{ status: "succeeded" }]);
    expect(unitId).toBe(`stub-coord-final:${FOLLOW_UP_COORD_ID}`);
  });

  it("U8 — worker.failed → finishWorkflow(failed) then onTerminal(succeeded)", async () => {
    const { callLog, onTerminalCalls } = await runStep2("failed");
    expect(callLog).toEqual(["getDag", "finishWorkflow:failed", "onTerminal:succeeded"]);
    expect(onTerminalCalls).toEqual([{ status: "succeeded" }]);
  });

  it("U9 — worker.cancelled → finishWorkflow(failed) then onTerminal(succeeded)", async () => {
    const { callLog, onTerminalCalls } = await runStep2("cancelled");
    expect(callLog).toEqual(["getDag", "finishWorkflow:failed", "onTerminal:succeeded"]);
    expect(onTerminalCalls).toEqual([{ status: "succeeded" }]);
  });
});

describe("@emploke/api workflow-coord-runner — defensive branch (U10)", () => {
  it("U10 — unexpected coord count (3) → onTerminal(failed, reason includes coordCount)", async () => {
    const dag = dagFor(
      [
        { id: INITIAL_COORD_ID, kind: "coordinator", status: "succeeded" },
        { id: FOLLOW_UP_COORD_ID, kind: "coordinator", status: "succeeded" },
        { id: "550e8400-e29b-41d4-a716-446655440099", kind: "coordinator", status: "running" },
      ],
      [],
    );
    const { service, callLog, addNodeMock, finishWorkflowMock } = makeMockService({ dag });
    const onTerminalCalls: WorkflowNodeTerminalResult[] = [];
    const runner = makeWorkflowStubCoordRunner({ getService: () => service });

    const result = await runner.dispatch({
      workflowId: WORKFLOW_ID,
      nodeId: "550e8400-e29b-41d4-a716-446655440099",
      spec: { agent: COORD_AGENT },
      nodeDir: "/tmp/nodedir",
      onTerminal: (r) => {
        onTerminalCalls.push(r);
      },
    });

    expect(callLog).toEqual(["getDag"]);
    expect(addNodeMock).not.toHaveBeenCalled();
    expect(finishWorkflowMock).not.toHaveBeenCalled();
    expect(onTerminalCalls).toHaveLength(1);
    const terminal = onTerminalCalls[0];
    expect(terminal?.status).toBe("failed");
    if (terminal?.status === "failed") {
      expect(terminal.reason).toContain("coordCount=3");
      expect(terminal.reason).toContain("unexpected DAG state");
    }
    expect(result.unitId).toContain("stub-coord-unknown:");
  });

  it("zero coord nodes (unreachable in practice) → onTerminal(failed, coordCount=0)", async () => {
    const dag = dagFor([], []);
    const { service } = makeMockService({ dag });
    const onTerminalCalls: WorkflowNodeTerminalResult[] = [];
    const runner = makeWorkflowStubCoordRunner({ getService: () => service });
    await runner.dispatch({
      workflowId: WORKFLOW_ID,
      nodeId: INITIAL_COORD_ID,
      spec: { agent: COORD_AGENT },
      nodeDir: "/tmp/nodedir",
      onTerminal: (r) => onTerminalCalls.push(r),
    });
    const terminal = onTerminalCalls[0];
    expect(terminal?.status).toBe("failed");
    if (terminal?.status === "failed") {
      expect(terminal.reason).toContain("coordCount=0");
    }
  });
});

describe("@emploke/api workflow-coord-runner — two-phase init diagnostic (U11)", () => {
  it("U11 — dispatch when getService returns null throws diagnostic naming the wiring step", async () => {
    const runner = makeWorkflowStubCoordRunner({
      getService: () => null as unknown as WorkflowService,
    });

    await expect(
      runner.dispatch({
        workflowId: WORKFLOW_ID,
        nodeId: INITIAL_COORD_ID,
        spec: { agent: COORD_AGENT },
        nodeDir: "/tmp/nodedir",
        onTerminal: () => {
          /* unused */
        },
      }),
    ).rejects.toThrow(/service used before composeWorkflowModule returned/);
  });

  it("U11 — diagnostic mentions the most-likely root cause (compose-time wiring)", async () => {
    const runner = makeWorkflowStubCoordRunner({
      getService: () => undefined as unknown as WorkflowService,
    });

    await expect(
      runner.dispatch({
        workflowId: WORKFLOW_ID,
        nodeId: INITIAL_COORD_ID,
        spec: { agent: COORD_AGENT },
        nodeDir: "/tmp/nodedir",
        onTerminal: () => {
          /* unused */
        },
      }),
    ).rejects.toThrow(/compose-time wiring/);
  });
});

describe("@emploke/api workflow-coord-runner — hasInFlightForNode / cancel (U12/U13)", () => {
  const runner = makeWorkflowStubCoordRunner({
    getService: () => ({}) as unknown as WorkflowService,
  });

  it("U12 — hasInFlightForNode always returns false", async () => {
    expect(await runner.hasInFlightForNode("anything")).toBe(false);
    expect(await runner.hasInFlightForNode(INITIAL_COORD_ID)).toBe(false);
    expect(await runner.hasInFlightForNode("")).toBe(false);
  });

  it("U13 — cancel resolves with undefined and does not throw", async () => {
    await expect(runner.cancel("anything")).resolves.toBeUndefined();
    await expect(runner.cancel(INITIAL_COORD_ID)).resolves.toBeUndefined();
  });
});

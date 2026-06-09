import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowDagWire, WorkflowHeaderWire, WorkflowNodeWire } from "../../../src/api";
import { WorkflowMetaStats } from "../../../src/components/workflows/WorkflowMetaStats";

// Local mirror of the lifecycle-status literal union (not re-exported from
// the dashboard `api` index). Keeps the test self-contained.
type NodeStatus = "not_started" | "ready" | "running" | "succeeded" | "failed" | "cancelled";

function makeWorkflow(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-meta",
    brief: "meta test",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeNode(id: string, phase: number, status: NodeStatus): WorkflowNodeWire {
  return {
    id,
    workflowId: "wf-meta",
    phase,
    status,
    spec: { kind: "worker", agent: "emploke/dev", brief: id },
    createdAt: "2026-05-28T00:00:00.000Z",
  };
}

function makeDag(nodes: readonly WorkflowNodeWire[], wf?: WorkflowHeaderWire): WorkflowDagWire {
  const workflow = wf ?? makeWorkflow();
  return { workflow, nodes, edges: [] };
}

afterEach(() => cleanup());

describe("WorkflowMetaStats — Phases stat semantics (current / total format)", () => {
  it("omits the Phases stat entirely while the DAG is still loading (dag === null)", () => {
    render(<WorkflowMetaStats workflow={makeWorkflow()} dag={null} />);
    expect(screen.queryByTestId("workflow-meta-phases")).toBeNull();
  });

  it("(a) renders 0 / 3 when the workflow is at the first phase of a 3-phase DAG", () => {
    // Phase 0 is running, downstream phases 1 + 2 are not yet started — the
    // workflow is "currently executing phase 0 of 3 total phases".
    const dag = makeDag([
      makeNode("n-0", 0, "running"),
      makeNode("n-1", 1, "not_started"),
      makeNode("n-2", 2, "not_started"),
    ]);
    render(<WorkflowMetaStats workflow={makeWorkflow()} dag={dag} />);
    const stat = screen.getByTestId("workflow-meta-phases");
    // Display must be the literal `current / total` format. We assert both
    // halves explicitly so an accidental swap regression is loud.
    expect(stat.textContent).toContain("0 / 3");
    // And the old single-number `3` rendering (max + 1) MUST NOT surface.
    expect(stat.textContent).not.toMatch(/Phases\s+3\s*$/);
  });

  it("(b) renders 1 / 3 mid-execution when phase 0 succeeded + phase 1 is running", () => {
    // Phase 0 is terminal-succeeded; phase 1 picked up next, phase 2 still
    // not_started. Current = lowest active phase = 1; total = 3.
    const dag = makeDag([
      makeNode("n-0", 0, "succeeded"),
      makeNode("n-1", 1, "running"),
      makeNode("n-2", 2, "not_started"),
    ]);
    render(<WorkflowMetaStats workflow={makeWorkflow()} dag={dag} />);
    expect(screen.getByTestId("workflow-meta-phases").textContent).toContain("1 / 3");
  });

  it("(c) when every node is terminal, renders last / total (NOT last+1 / total)", () => {
    // Fully completed workflow — every node has reached a terminal state.
    // The brief explicitly calls out that `2 / 3` is correct here, NOT
    // `3 / 3` (the previous max+1 rendering was off-by-one for this case).
    const dag = makeDag([
      makeNode("n-0", 0, "succeeded"),
      makeNode("n-1", 1, "succeeded"),
      makeNode("n-2", 2, "succeeded"),
    ]);
    render(<WorkflowMetaStats workflow={makeWorkflow({ status: "succeeded" })} dag={dag} />);
    const stat = screen.getByTestId("workflow-meta-phases");
    expect(stat.textContent).toContain("2 / 3");
    expect(stat.textContent).not.toContain("3 / 3");
  });

  it("(c') treats `cancelled` the same as other terminal statuses (last / total, not last+1 / total)", () => {
    // `cancelled` is a distinct terminal lifecycle state alongside
    // `succeeded` / `failed`; assert it picks up the same `last / total`
    // rendering rather than falling through to a phantom "active" branch.
    const dag = makeDag([
      makeNode("n-0", 0, "cancelled"),
      makeNode("n-1", 1, "cancelled"),
      makeNode("n-2", 2, "cancelled"),
    ]);
    render(<WorkflowMetaStats workflow={makeWorkflow({ status: "cancelled" })} dag={dag} />);
    const stat = screen.getByTestId("workflow-meta-phases");
    expect(stat.textContent).toContain("2 / 3");
    expect(stat.textContent).not.toContain("3 / 3");
  });

  it("omits the Phases stat when the DAG has zero nodes (workflow just created, coord hasn't extended DAG yet)", () => {
    // Edge case: workflow row exists but the coordinator hasn't proposed
    // any nodes yet. A `0 / 0` rendering would be meaningless, so the
    // stat is suppressed entirely — matches the `dag === null` treatment
    // above and the broader "omit when not yet known" convention.
    render(<WorkflowMetaStats workflow={makeWorkflow()} dag={makeDag([])} />);
    expect(screen.queryByTestId("workflow-meta-phases")).toBeNull();
  });

  it("tooltip drops the implementation-detail `max(node.phase) + 1` leak", () => {
    const dag = makeDag([makeNode("n-0", 0, "running")]);
    render(<WorkflowMetaStats workflow={makeWorkflow()} dag={dag} />);
    const stat = screen.getByTestId("workflow-meta-phases");
    expect(stat.getAttribute("title")).toBe("Current execution phase / total phases in the DAG");
    expect(stat.getAttribute("title")).not.toMatch(/max\(node\.phase\)/);
  });

  it("treats `ready` nodes the same as `not_started` / `running` (still 'active' for current-phase)", () => {
    // Phase 0 ready (eligible for dispatch but not yet running) — should
    // still pin `current` to 0 rather than skipping to phase 1.
    const dag = makeDag([makeNode("n-0", 0, "ready"), makeNode("n-1", 1, "not_started")]);
    render(<WorkflowMetaStats workflow={makeWorkflow()} dag={dag} />);
    expect(screen.getByTestId("workflow-meta-phases").textContent).toContain("0 / 2");
  });
});

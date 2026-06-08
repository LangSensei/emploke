import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowDagWire, WorkflowNodeWire } from "../../../src/api";
import { WorkflowDagView } from "../../../src/pages/workflows/WorkflowDagView";

function makeNode(overrides: Partial<WorkflowNodeWire> = {}): WorkflowNodeWire {
  return {
    id: "n-default",
    workflowId: "wf-1",
    status: "running",
    phase: 0,
    spec: { kind: "task", agent: "emploke/dev", brief: "default brief" },
    createdAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeDag(nodes: WorkflowNodeWire[]): WorkflowDagWire {
  return {
    workflow: {
      id: "wf-1",
      brief: "Wrapped header",
      status: "running",
      coordinatorAgent: "emploke/dev",
      metadata: {},
      createdAt: "2026-05-28T00:00:00.000Z",
      iterationCount: 0,
    },
    nodes,
    edges: [],
  };
}

afterEach(() => cleanup());

describe("WorkflowDagView — empty state", () => {
  it("renders an empty-state when the DAG has no nodes", () => {
    render(<WorkflowDagView dag={makeDag([])} />);
    expect(screen.getByTestId("workflow-dag-empty")).toBeTruthy();
  });
});

describe("WorkflowDagView — phase grouping", () => {
  it("renders one column per phase, sorted by phase ascending", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-phase2",
            phase: 2,
            spec: { kind: "task", agent: "emploke/review", brief: "b2" },
          }),
          makeNode({
            id: "n-phase0",
            phase: 0,
            spec: { kind: "coordinator", agent: "emploke/dev" },
          }),
          makeNode({
            id: "n-phase1",
            phase: 1,
            spec: { kind: "task", agent: "emploke/dev", brief: "b1" },
          }),
        ])}
      />,
    );
    const phases = document.querySelectorAll("[data-testid^='workflow-dag-phase-']");
    expect(phases).toHaveLength(3);
    expect(phases[0]?.getAttribute("data-phase")).toBe("0");
    expect(phases[1]?.getAttribute("data-phase")).toBe("1");
    expect(phases[2]?.getAttribute("data-phase")).toBe("2");
  });

  it("within a phase, sorts nodes by createdAt ascending", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-later",
            phase: 0,
            createdAt: "2026-05-28T00:02:00.000Z",
            spec: { kind: "task", agent: "emploke/dev", brief: "later" },
          }),
          makeNode({
            id: "n-earlier",
            phase: 0,
            createdAt: "2026-05-28T00:01:00.000Z",
            spec: { kind: "task", agent: "emploke/dev", brief: "earlier" },
          }),
        ])}
      />,
    );
    const col = screen.getByTestId("workflow-dag-phase-0");
    const nodes = within(col).getAllByTestId(/^dag-node-/);
    expect(nodes[0]?.getAttribute("data-node-id")).toBe("n-earlier");
    expect(nodes[1]?.getAttribute("data-node-id")).toBe("n-later");
  });
});

describe("WorkflowDagView — kind-driven styling and content", () => {
  it("applies the coordinator + task modifier classes per node kind", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-coord",
            phase: 0,
            spec: { kind: "coordinator", agent: "emploke/dev" },
          }),
          makeNode({
            id: "n-task",
            phase: 1,
            spec: { kind: "task", agent: "emploke/review", brief: "x" },
          }),
        ])}
      />,
    );
    const coord = screen.getByTestId("dag-node-n-coord");
    const task = screen.getByTestId("dag-node-n-task");
    expect(coord.className).toContain("dag-node--coordinator");
    expect(task.className).toContain("dag-node--task");
    expect(coord.textContent).toContain("emploke/dev");
    expect(task.textContent).toContain("emploke/review");
  });
});

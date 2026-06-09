import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDagWire, WorkflowHeaderWire } from "../../../src/api";

vi.mock("../../../src/hooks/useTaskDetail", () => ({
  useTaskDetail: () => ({
    task: null,
    activity: null,
    activityError: null,
    refresh: vi.fn(),
    loadOlder: vi.fn(),
  }),
}));

import { WorkflowNodeTaskPane } from "../../../src/pages/workflows/WorkflowNodeTaskPane";

function makeWf(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-1",
    brief: "test workflow",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 0,
    ...overrides,
  };
}

function makeDag(): WorkflowDagWire {
  return {
    workflow: makeWf(),
    nodes: [
      {
        id: "n1",
        workflowId: "wf-1",
        status: "succeeded",
        phase: 0,
        spec: { kind: "worker", agent: "emploke/dev", brief: "a" },
        createdAt: "2026-05-28T00:00:00.000Z",
        taskId: "task-1",
      },
      {
        id: "n2",
        workflowId: "wf-1",
        status: "running",
        phase: 1,
        spec: { kind: "worker", agent: "emploke/dev", brief: "b" },
        createdAt: "2026-05-28T00:01:00.000Z",
        taskId: "task-2",
      },
      {
        id: "n3",
        workflowId: "wf-1",
        status: "running",
        phase: 2,
        spec: { kind: "worker", agent: "emploke/dev", brief: "c" },
        createdAt: "2026-05-28T00:02:00.000Z",
        taskId: "task-3",
      },
    ],
    edges: [],
  };
}

afterEach(() => cleanup());

describe("WorkflowNodeTaskPane", () => {
  it("renders the nav pill with N/M position counter", () => {
    render(
      <WorkflowNodeTaskPane
        workflow={makeWf()}
        dag={makeDag()}
        nodeTaskId="task-2"
        pollIntervalMs={4000}
        onBack={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByTestId("workflow-node-position").textContent).toBe("2 / 3");
  });

  it("fires onBack when the back button is clicked", () => {
    const onBack = vi.fn();
    render(
      <WorkflowNodeTaskPane
        workflow={makeWf()}
        dag={makeDag()}
        nodeTaskId="task-2"
        pollIntervalMs={4000}
        onBack={onBack}
        onNavigate={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("workflow-node-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("fires onNavigate with the previous node's taskId on prev click", () => {
    const onNavigate = vi.fn();
    render(
      <WorkflowNodeTaskPane
        workflow={makeWf()}
        dag={makeDag()}
        nodeTaskId="task-2"
        pollIntervalMs={4000}
        onBack={() => {}}
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(screen.getByTestId("workflow-node-prev"));
    expect(onNavigate).toHaveBeenCalledWith("task-1");
  });

  it("disables prev at the first node and next at the last node", () => {
    const { rerender } = render(
      <WorkflowNodeTaskPane
        workflow={makeWf()}
        dag={makeDag()}
        nodeTaskId="task-1"
        pollIntervalMs={4000}
        onBack={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect((screen.getByTestId("workflow-node-prev") as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <WorkflowNodeTaskPane
        workflow={makeWf()}
        dag={makeDag()}
        nodeTaskId="task-3"
        pollIntervalMs={4000}
        onBack={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect((screen.getByTestId("workflow-node-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a 'Node not found' fallback when the nodeTaskId is not in the dag", () => {
    render(
      <WorkflowNodeTaskPane
        workflow={makeWf()}
        dag={makeDag()}
        nodeTaskId="task-unknown"
        pollIntervalMs={4000}
        onBack={() => {}}
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByTestId("workflow-node-not-found")).toBeTruthy();
  });
});

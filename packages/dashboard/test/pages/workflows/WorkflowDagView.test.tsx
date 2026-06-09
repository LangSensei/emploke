import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDagWire, WorkflowNodeWire } from "../../../src/api";
import { WorkflowDagView } from "../../../src/pages/workflows/WorkflowDagView";

function makeNode(overrides: Partial<WorkflowNodeWire> = {}): WorkflowNodeWire {
  return {
    id: "n-default",
    workflowId: "wf-1",
    status: "running",
    phase: 0,
    spec: { kind: "worker", agent: "emploke/dev", brief: "default brief" },
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

  it("the empty-state container is NOT keyboard-focusable", () => {
    // axe `scrollable-region-focusable` only flags overflow regions; the
    // empty-state placeholder has no overflowing content, so leaving
    // `tabindex` off matches the "skip non-interactive landmarks" intent.
    render(<WorkflowDagView dag={makeDag([])} />);
    const empty = screen.getByTestId("workflow-dag-empty");
    expect(empty.hasAttribute("tabindex")).toBe(false);
  });
});

describe("WorkflowDagView — keyboard-scrollable region", () => {
  it("the DAG container exposes tabindex=0 so keyboard users can scroll the overflow", () => {
    // axe-core flags `scrollable-region-focusable` (Level A, serious) when
    // a container with overflow:auto/scroll is not keyboard-focusable.
    // The DAG's `.workflow-dag` rule sets `overflow-x: auto`, so the
    // container needs `tabIndex={0}` to be reachable via Tab.
    render(<WorkflowDagView dag={makeDag([makeNode({ id: "n-only", phase: 0 })])} />);
    const region = screen.getByTestId("workflow-dag");
    expect(region.getAttribute("tabindex")).toBe("0");
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
            spec: { kind: "worker", agent: "emploke/review", brief: "b2" },
          }),
          makeNode({
            id: "n-phase0",
            phase: 0,
            spec: { kind: "coordinator", agent: "emploke/dev" },
          }),
          makeNode({
            id: "n-phase1",
            phase: 1,
            spec: { kind: "worker", agent: "emploke/dev", brief: "b1" },
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
            spec: { kind: "worker", agent: "emploke/dev", brief: "later" },
          }),
          makeNode({
            id: "n-earlier",
            phase: 0,
            createdAt: "2026-05-28T00:01:00.000Z",
            spec: { kind: "worker", agent: "emploke/dev", brief: "earlier" },
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
  it("applies the coordinator + worker modifier classes per node kind", () => {
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
            spec: { kind: "worker", agent: "emploke/review", brief: "x" },
          }),
        ])}
      />,
    );
    const coord = screen.getByTestId("dag-node-n-coord");
    const task = screen.getByTestId("dag-node-n-task");
    expect(coord.className).toContain("dag-node--coordinator");
    expect(task.className).toContain("dag-node--worker");
    expect(coord.textContent).toContain("emploke/dev");
    expect(task.textContent).toContain("emploke/review");
  });
});

describe("WorkflowDagView — node card content", () => {
  // Constant `runningAt` baseline so the relative-time output is stable
  // across machines. `formatRelative` shows "Xd ago" until 30 days then
  // falls back to a locale date string, so dates far enough in the past
  // produce text that contains the absolute year — sufficient to assert
  // the element rendered without depending on exact wall-clock seconds.
  const RUNNING_AT = "2025-01-01T00:00:00.000Z";
  const ENDED_AT = "2025-01-01T00:05:30.000Z";

  it("worker node shows brief + status when not_started (no started/runtime yet)", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-pending",
            phase: 0,
            status: "not_started",
            spec: { kind: "worker", agent: "emploke/dev", brief: "fix the parser" },
          }),
        ])}
      />,
    );
    expect(screen.getByTestId("dag-brief-n-pending").textContent).toContain("fix the parser");
    expect(screen.queryByTestId("dag-started-n-pending")).toBeNull();
    expect(screen.queryByTestId("dag-runtime-n-pending")).toBeNull();
  });

  it("running worker node shows brief + started-at + live runtime", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-running",
            phase: 0,
            status: "running",
            runningAt: RUNNING_AT,
            spec: { kind: "worker", agent: "emploke/dev", brief: "in flight" },
          }),
        ])}
      />,
    );
    expect(screen.getByTestId("dag-brief-n-running").textContent).toContain("in flight");
    expect(screen.getByTestId("dag-started-n-running").textContent).toContain("started");
    const runtime = screen.getByTestId("dag-runtime-n-running");
    // Live runtime uses the "running" verb (vs terminal "ran") so a glance
    // distinguishes the lifecycle without colour cues.
    expect(runtime.textContent).toMatch(/^running\s+/);
  });

  it("succeeded worker node shows final 'ran <duration>' runtime", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-ok",
            phase: 0,
            status: "succeeded",
            runningAt: RUNNING_AT,
            endedAt: ENDED_AT,
            spec: { kind: "worker", agent: "emploke/dev", brief: "done" },
          }),
        ])}
      />,
    );
    const runtime = screen.getByTestId("dag-runtime-n-ok");
    expect(runtime.textContent).toContain("ran");
    // 5m 30s elapsed between RUNNING_AT and ENDED_AT — formatDuration emits
    // "5m 30s" for the two-unit window.
    expect(runtime.textContent).toContain("5m 30s");
  });

  it("failed worker node still shows started + final runtime (terminal but had run)", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-fail",
            phase: 0,
            status: "failed",
            runningAt: RUNNING_AT,
            endedAt: ENDED_AT,
            spec: { kind: "worker", agent: "emploke/dev", brief: "bad" },
          }),
        ])}
      />,
    );
    expect(screen.getByTestId("dag-started-n-fail")).toBeTruthy();
    expect(screen.getByTestId("dag-runtime-n-fail").textContent).toContain("ran");
  });

  it("coordinator node omits the brief (no spec.brief) but still renders started + runtime when running", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-coord",
            phase: 0,
            status: "running",
            runningAt: RUNNING_AT,
            spec: { kind: "coordinator", agent: "emploke/dev" },
          }),
        ])}
      />,
    );
    // No brief surface for coords (their spec has no `brief` field).
    expect(screen.queryByTestId("dag-brief-n-coord")).toBeNull();
    expect(screen.getByTestId("dag-started-n-coord")).toBeTruthy();
    expect(screen.getByTestId("dag-runtime-n-coord")).toBeTruthy();
  });
});

describe("WorkflowDagView — Mode B node activation (spec v2.1)", () => {
  it("renders nodes as <button> when onSelectNode is provided and fires the callback on click", () => {
    const onSelectNode = vi.fn();
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-a",
            phase: 0,
            taskId: "task-a",
            spec: { kind: "worker", agent: "emploke/dev", brief: "a" },
          }),
        ])}
        onSelectNode={onSelectNode}
      />,
    );
    const node = screen.getByTestId("dag-node-n-a");
    expect(node.tagName).toBe("BUTTON");
    fireEvent.click(node);
    expect(onSelectNode).toHaveBeenCalledTimes(1);
    expect(onSelectNode.mock.calls[0]?.[0]?.id).toBe("n-a");
  });

  it("does not fire onSelectNode when the node has no taskId (aria-disabled)", () => {
    const onSelectNode = vi.fn();
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-no-task",
            phase: 0,
            spec: { kind: "worker", agent: "emploke/dev", brief: "x" },
          }),
        ])}
        onSelectNode={onSelectNode}
      />,
    );
    const node = screen.getByTestId("dag-node-n-no-task");
    expect(node.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(node);
    expect(onSelectNode).not.toHaveBeenCalled();
  });

  it("paints the matching node with aria-current='true' + .dag-node--selected when selectedNodeId is set", () => {
    render(
      <WorkflowDagView
        dag={makeDag([
          makeNode({
            id: "n-a",
            phase: 0,
            taskId: "task-a",
            spec: { kind: "worker", agent: "emploke/dev", brief: "a" },
          }),
          makeNode({
            id: "n-b",
            phase: 0,
            createdAt: "2026-05-28T00:01:00.000Z",
            taskId: "task-b",
            spec: { kind: "worker", agent: "emploke/dev", brief: "b" },
          }),
        ])}
        selectedNodeId="n-b"
        onSelectNode={() => {}}
      />,
    );
    const selected = screen.getByTestId("dag-node-n-b");
    const other = screen.getByTestId("dag-node-n-a");
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(selected.className).toContain("dag-node--selected");
    expect(other.getAttribute("aria-current")).toBeNull();
  });

  it("renders SVG overlay with an arrow marker when the dag has edges", () => {
    render(
      <WorkflowDagView
        dag={{
          ...makeDag([makeNode({ id: "n-a", phase: 0 }), makeNode({ id: "n-b", phase: 1 })]),
          edges: [{ from: "n-a", to: "n-b" }],
        }}
      />,
    );
    const container = screen.getByTestId("workflow-dag");
    const svg = container.querySelector("svg.workflow-dag__edges");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("marker")).toBeTruthy();
  });
});

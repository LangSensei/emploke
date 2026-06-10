import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDagWire, WorkflowHeaderWire } from "../../../src/api";

vi.mock("../../../src/api", async () => {
  const actual = await vi.importActual<typeof import("../../../src/api")>("../../../src/api");
  return {
    ...actual,
    listWorkflowArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
    workflowArtifactUrl: (id: string, sub: string) => `/${id}/${sub}`,
  };
});

import { WorkflowView } from "../../../src/pages/workflows/WorkflowView";

function makeWf(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-1",
    brief: "Default",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 0,
    ...overrides,
  };
}

function makeDag(wf: WorkflowHeaderWire): WorkflowDagWire {
  return {
    workflow: wf,
    nodes: [
      {
        id: "n1",
        workflowId: wf.id,
        status: "running",
        phase: 0,
        spec: { kind: "worker", agent: "emploke/dev", brief: "x" },
        metadata: {},
        createdAt: wf.createdAt,
        taskId: "task-1",
      },
    ],
    edges: [],
  };
}

afterEach(() => cleanup());

describe("WorkflowView — tablist", () => {
  it("renders the three tabs and the overview tab is active on mount", () => {
    const wf = makeWf();
    render(
      <WorkflowView workflow={wf} dag={makeDag(wf)} dagError={null} onSelectNode={() => {}} />,
    );
    expect(screen.getByTestId("workflow-tab-overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("workflow-tab-graph").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTestId("workflow-tab-artifacts").getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(screen.getByTestId("workflow-tabpanel-overview")).toBeTruthy();
  });

  it("swaps the active panel when a tab is clicked", () => {
    const wf = makeWf();
    render(
      <WorkflowView workflow={wf} dag={makeDag(wf)} dagError={null} onSelectNode={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("workflow-tab-graph"));
    expect(screen.getByTestId("workflow-tab-graph").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("workflow-tabpanel-graph")).toBeTruthy();
  });

  it("ArrowRight / ArrowLeft cycles through tabs (WAI-ARIA tablist)", () => {
    const wf = makeWf();
    render(
      <WorkflowView workflow={wf} dag={makeDag(wf)} dagError={null} onSelectNode={() => {}} />,
    );
    const overviewTab = screen.getByTestId("workflow-tab-overview");
    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });
    expect(screen.getByTestId("workflow-tab-graph").getAttribute("aria-selected")).toBe("true");

    const graphTab = screen.getByTestId("workflow-tab-graph");
    fireEvent.keyDown(graphTab, { key: "ArrowRight" });
    expect(screen.getByTestId("workflow-tab-artifacts").getAttribute("aria-selected")).toBe("true");

    const artifactsTab = screen.getByTestId("workflow-tab-artifacts");
    fireEvent.keyDown(artifactsTab, { key: "ArrowLeft" });
    expect(screen.getByTestId("workflow-tab-graph").getAttribute("aria-selected")).toBe("true");
  });

  it("Home / End jump to first / last tab", () => {
    const wf = makeWf();
    render(
      <WorkflowView workflow={wf} dag={makeDag(wf)} dagError={null} onSelectNode={() => {}} />,
    );
    const overviewTab = screen.getByTestId("workflow-tab-overview");
    fireEvent.keyDown(overviewTab, { key: "End" });
    expect(screen.getByTestId("workflow-tab-artifacts").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("workflow-tab-artifacts"), { key: "Home" });
    expect(screen.getByTestId("workflow-tab-overview").getAttribute("aria-selected")).toBe("true");
  });
});

describe("WorkflowView — detail-page action surface (v2.2)", () => {
  it("does NOT render the detail-page Cancel CTA for running workflows", () => {
    // Regression guard for v2.2: row `⋯` menu owns Cancel; the detail
    // pane is no longer an action surface for it. A future regression
    // that wires a Cancel button back onto the detail page would split
    // the action affordance and confuse users.
    render(
      <WorkflowView
        workflow={makeWf({ status: "running" })}
        dag={null}
        dagError={null}
        onSelectNode={() => {}}
      />,
    );
    expect(screen.queryByTestId("workflow-detail-cancel")).toBeNull();
  });

  it("does NOT render the detail-page Cancel CTA for terminal workflows either", () => {
    render(
      <WorkflowView
        workflow={makeWf({ status: "succeeded" })}
        dag={null}
        dagError={null}
        onSelectNode={() => {}}
      />,
    );
    expect(screen.queryByTestId("workflow-detail-cancel")).toBeNull();
  });
});

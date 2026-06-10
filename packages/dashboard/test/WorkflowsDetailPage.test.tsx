import type { AgentEntry } from "@emploke/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDagWire, WorkflowHeaderWire } from "../src/api";

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listWorkflows: vi.fn(),
    getWorkflow: vi.fn(),
    getWorkflowDag: vi.fn(),
    createWorkflow: vi.fn(),
    cancelWorkflow: vi.fn(),
  };
});

import * as api from "../src/api";
import { HeaderActionsContext } from "../src/components/HeaderActions";
import { WorkflowsPage } from "../src/pages/Workflows";

const mockListWorkflows = api.listWorkflows as unknown as ReturnType<typeof vi.fn>;
const mockGetWorkflow = api.getWorkflow as unknown as ReturnType<typeof vi.fn>;
const mockGetWorkflowDag = api.getWorkflowDag as unknown as ReturnType<typeof vi.fn>;
const mockCancelWorkflow = api.cancelWorkflow as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

function makeWorkflow(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-detail",
    brief: "Detail workflow",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 3,
    ...overrides,
  };
}

function makeDag(wf: WorkflowHeaderWire): WorkflowDagWire {
  return {
    workflow: wf,
    nodes: [
      {
        id: "node-1",
        workflowId: wf.id,
        status: wf.status === "running" ? "running" : "succeeded",
        phase: 0,
        spec: { kind: "coordinator", agent: wf.coordinatorAgent },
        createdAt: wf.createdAt,
        readyAt: wf.createdAt,
        runningAt: wf.createdAt,
      },
    ],
    edges: [],
  };
}

function renderWorkflows(initialPath: string, agents: AgentEntry[]) {
  const headerHost = document.createElement("div");
  document.body.appendChild(headerHost);
  return render(
    <HeaderActionsContext.Provider value={headerHost}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/workspaces/:wsId/runtime/workflows"
            element={<WorkflowsPage agents={agents} currentWorkspaceId="ws-1" />}
          />
        </Routes>
      </MemoryRouter>
    </HeaderActionsContext.Provider>,
  );
}

beforeEach(() => {
  mockListWorkflows.mockReset();
  mockGetWorkflow.mockReset();
  mockGetWorkflowDag.mockReset();
  mockCancelWorkflow.mockReset();
});

afterEach(() => cleanup());

describe("WorkflowsPage — detail header", () => {
  const agents = [makeAgent("emploke/dev")];

  it("renders the header (brief, status badge, coordinator, phases) for the selected workflow", async () => {
    const wf = makeWorkflow({ id: "wf-1", brief: "Headline brief", iterationCount: 7 });
    mockListWorkflows.mockResolvedValue([wf]);
    mockGetWorkflow.mockResolvedValue(wf);
    // DAG with two distinct phases. Both nodes are still running, so
    // `current` = lowest active phase = 0 and `total` = max(phase) + 1
    // = 2 — the rendered chip is `Phases 1 / 2` (1-indexed display)
    // (replacing the prior single number `2` from the max+1 stat).
    mockGetWorkflowDag.mockResolvedValue({
      workflow: wf,
      nodes: [
        {
          id: "node-1",
          workflowId: wf.id,
          status: "running",
          phase: 0,
          spec: { kind: "coordinator", agent: wf.coordinatorAgent },
          createdAt: wf.createdAt,
        },
        {
          id: "node-2",
          workflowId: wf.id,
          status: "running",
          phase: 1,
          spec: { kind: "worker", agent: "emploke/dev", brief: "x" },
          createdAt: wf.createdAt,
        },
      ],
      edges: [],
    });

    renderWorkflows("/workspaces/ws-1/runtime/workflows?workflowId=wf-1", agents);

    await waitFor(() => {
      expect(screen.getByTestId("workflow-detail")).toBeTruthy();
    });
    const detail = screen.getByTestId("workflow-detail");
    expect(detail.textContent).toContain("Headline brief");
    expect(detail.textContent).toContain("emploke/dev");
    expect(detail.textContent).toContain("Phases");
    // Stat renders 1-indexed `current / total` — both nodes are running,
    // so `current` = 0 (lowest active phase, 0-indexed) and `total` = 2
    // (max phase + 1), surfaced as the 1-indexed display `1 / 2`.
    expect(detail.textContent).toContain("1 / 2");
    // v2.2: iter chip no longer rendered anywhere in the detail pane.
    expect(detail.textContent).not.toContain("Iterations");
    expect(detail.querySelector("[data-testid='workflow-status-badge-running']")).toBeTruthy();
  });

  it("does NOT render a Cancel CTA on the detail page (v2.2 — row menu owns Cancel)", async () => {
    const wf = makeWorkflow({ id: "wf-running", status: "running" });
    mockListWorkflows.mockResolvedValue([wf]);
    mockGetWorkflow.mockResolvedValue(wf);
    mockGetWorkflowDag.mockResolvedValue(makeDag(wf));

    renderWorkflows("/workspaces/ws-1/runtime/workflows?workflowId=wf-running", agents);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-detail")).toBeTruthy();
    });
    expect(screen.queryByTestId("workflow-detail-cancel")).toBeNull();
  });

  it("row `⋯` menu opens the cancel modal and dispatches cancelWorkflow with the entered reason", async () => {
    const wf = makeWorkflow({ id: "wf-running", status: "running" });
    mockListWorkflows.mockResolvedValue([wf]);
    mockGetWorkflow.mockResolvedValue(wf);
    mockGetWorkflowDag.mockResolvedValue(makeDag(wf));
    mockCancelWorkflow.mockResolvedValue({ ...wf, status: "cancelled" });

    renderWorkflows("/workspaces/ws-1/runtime/workflows?workflowId=wf-running", agents);
    await waitFor(() => {
      expect(screen.getByTestId(`workflow-row-menu-trigger-${wf.id}`)).toBeTruthy();
    });
    // Open the row menu, then click the Cancel menuitem.
    fireEvent.click(screen.getByTestId(`workflow-row-menu-trigger-${wf.id}`));
    await waitFor(() => {
      expect(screen.getByTestId(`workflow-row-menu-cancel-${wf.id}`)).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId(`workflow-row-menu-cancel-${wf.id}`));

    await waitFor(() => {
      expect(screen.getByTestId("cancel-workflow-confirm")).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId("cancel-workflow-reason"), {
      target: { value: "no longer needed" },
    });
    fireEvent.click(screen.getByTestId("cancel-workflow-confirm"));

    await waitFor(() => {
      expect(mockCancelWorkflow).toHaveBeenCalledWith("wf-running", {
        cancellation: { kind: "user", message: "no longer needed" },
      });
    });
  });

  it("renders the detail-pane skeleton while the per-workflow fetch is in flight, then swaps for the resolved detail", async () => {
    const wf = makeWorkflow({ id: "wf-pending-detail", brief: "Pending detail" });
    mockListWorkflows.mockResolvedValue([wf]);
    // Hold the per-workflow read in pending so the skeleton branch is
    // observable, then resolve after asserting it rendered.
    let resolveWf: (v: WorkflowHeaderWire) => void = () => {};
    mockGetWorkflow.mockReturnValue(
      new Promise<WorkflowHeaderWire>((res) => {
        resolveWf = res;
      }),
    );
    mockGetWorkflowDag.mockResolvedValue(makeDag(wf));

    renderWorkflows(`/workspaces/ws-1/runtime/workflows?workflowId=${wf.id}`, agents);

    await waitFor(() => {
      expect(screen.getByTestId("workflow-detail-skeleton")).toBeTruthy();
    });

    resolveWf(wf);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-detail")).toBeTruthy();
    });
    expect(screen.queryByTestId("workflow-detail-skeleton")).toBeNull();
  });
});

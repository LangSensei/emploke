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
const mockCreateWorkflow = api.createWorkflow as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

function makeWorkflow(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-default",
    brief: "Default workflow",
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
        id: "node-1",
        workflowId: wf.id,
        status: "running",
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
  mockCreateWorkflow.mockReset();
  mockListWorkflows.mockResolvedValue([]);
  mockGetWorkflow.mockResolvedValue(undefined);
  mockGetWorkflowDag.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("WorkflowsPage — list rendering + sort", () => {
  const agents = [makeAgent("emploke/dev"), makeAgent("emploke/review")];

  it("renders one row per workflow, newest createdAt first", async () => {
    const older = makeWorkflow({
      id: "wf-older",
      brief: "Older one",
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    const newer = makeWorkflow({
      id: "wf-newer",
      brief: "Newer one",
      createdAt: "2026-05-28T00:00:00.000Z",
    });
    mockListWorkflows.mockResolvedValue([older, newer]);
    mockGetWorkflow.mockResolvedValue(newer);
    mockGetWorkflowDag.mockResolvedValue(makeDag(newer));

    renderWorkflows("/workspaces/ws-1/runtime/workflows", agents);

    await waitFor(() => {
      expect(screen.getByTestId("workflow-row-wf-newer")).toBeTruthy();
      expect(screen.getByTestId("workflow-row-wf-older")).toBeTruthy();
    });
    const rows = document.querySelectorAll("[data-testid^='workflow-row-wf-']");
    expect(rows[0]?.getAttribute("data-testid")).toBe("workflow-row-wf-newer");
    expect(rows[1]?.getAttribute("data-testid")).toBe("workflow-row-wf-older");
  });

  it("renders the zero-state when no workflows and no active filters", async () => {
    mockListWorkflows.mockResolvedValue([]);
    renderWorkflows("/workspaces/ws-1/runtime/workflows", agents);
    await waitFor(() => {
      expect(screen.getByTestId("workflows-empty-zero")).toBeTruthy();
    });
  });

  it("forwards ?q=foo to listWorkflows as { q: 'foo' }", async () => {
    mockListWorkflows.mockResolvedValue([]);
    renderWorkflows("/workspaces/ws-1/runtime/workflows?q=foo&range=all", agents);
    await waitFor(() => {
      expect(mockListWorkflows).toHaveBeenCalledWith({ q: "foo" });
    });
  });

  it("forwards ?agent=emploke/dev to listWorkflows as { coordinatorAgent: ... }", async () => {
    mockListWorkflows.mockResolvedValue([]);
    renderWorkflows("/workspaces/ws-1/runtime/workflows?agent=emploke%2Fdev&range=all", agents);
    await waitFor(() => {
      expect(mockListWorkflows).toHaveBeenCalledWith({ coordinatorAgent: "emploke/dev" });
    });
  });

  it("renders the filtered-empty state when a filter yields no rows", async () => {
    mockListWorkflows.mockResolvedValue([]);
    renderWorkflows("/workspaces/ws-1/runtime/workflows?q=missing&range=all", agents);
    await waitFor(() => {
      expect(screen.getByTestId("workflows-empty-filtered")).toBeTruthy();
    });
  });
});

describe("WorkflowsPage — New workflow CTA + create flow", () => {
  const agents = [makeAgent("emploke/dev")];

  it("renders the CTA into the header host", async () => {
    mockListWorkflows.mockResolvedValue([]);
    renderWorkflows("/workspaces/ws-1/runtime/workflows", agents);
    await waitFor(() => {
      expect(screen.getByTestId("workflows-new-cta")).toBeTruthy();
    });
  });

  it("opens the create modal and dispatches the create call on submit", async () => {
    const created = makeWorkflow({ id: "wf-fresh", brief: "Fresh one" });
    mockListWorkflows.mockResolvedValue([]);
    mockCreateWorkflow.mockResolvedValue(created);
    mockGetWorkflow.mockResolvedValue(created);
    mockGetWorkflowDag.mockResolvedValue(makeDag(created));

    renderWorkflows("/workspaces/ws-1/runtime/workflows", agents);

    await waitFor(() => expect(screen.getByTestId("workflows-new-cta")).toBeTruthy());
    fireEvent.click(screen.getByTestId("workflows-new-cta"));

    await waitFor(() => expect(screen.getByTestId("create-workflow-form")).toBeTruthy());
    fireEvent.change(screen.getByTestId("create-workflow-brief"), {
      target: { value: "Fresh one" },
    });
    fireEvent.click(screen.getByTestId("create-workflow-submit"));

    await waitFor(() => {
      expect(mockCreateWorkflow).toHaveBeenCalledWith({
        brief: "Fresh one",
        coordinatorAgent: "emploke/dev",
      });
    });
  });
});

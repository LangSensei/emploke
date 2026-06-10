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

function makeAgent(fqn: string, opts: { coordEligible?: boolean } = {}): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
    coordEligible: opts.coordEligible ?? true,
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
  // Detail-fetch defaults: park `getWorkflow` / `getWorkflowDag` in a
  // pending state so any test that exercises the list (causing the
  // page's auto-selection to fire `useWorkflowDetail`) keeps the
  // right pane parked on its loading skeleton.
  //
  // The prior defaults were `.mockResolvedValue(undefined)`. That
  // violated the typed `Promise<WorkflowHeaderWire>` contract: the
  // detail hook's `setWorkflow(header.value)` then handed `undefined`
  // to `<WorkflowView>`, which dereferences `workflow.brief` (see
  // `src/pages/workflows/WorkflowView.tsx:119`) and crashed the
  // entire root mid-test. With no error boundary the React 19 root
  // unmounted on the crash render, racing the `waitFor` MutationObserver
  // — whichever committed first decided pass vs fail. Faster runners
  // (macOS Apple Silicon in CI) lost the race more often, surfacing
  // the bug as "macOS flake".
  //
  // A never-settling promise here is the right safe default for tests
  // that do not opt into a specific detail-pane assertion. Tests that
  // do (`renders one row per workflow...`, `opens the create modal...`)
  // already override these with `mockResolvedValue(...)` of a real
  // `WorkflowHeaderWire`, so this change is transparent to them.
  mockGetWorkflow.mockReturnValue(new Promise<WorkflowHeaderWire>(() => {}));
  mockGetWorkflowDag.mockReturnValue(new Promise<WorkflowDagWire>(() => {}));
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

  it("shows the loading skeleton while the workflow list fetch is pending, then removes it on resolve", async () => {
    // Hold `listWorkflows` in a pending state so the loading branch is
    // observable. The skeleton then resolves out once the list arrives.
    let resolveList: (rows: WorkflowHeaderWire[]) => void = () => {};
    mockListWorkflows.mockReturnValue(
      new Promise<WorkflowHeaderWire[]>((res) => {
        resolveList = res;
      }),
    );

    renderWorkflows("/workspaces/ws-1/runtime/workflows", agents);

    // Pending → skeleton is in the DOM.
    await waitFor(() => {
      expect(screen.getByTestId("workflow-list-skeleton")).toBeTruthy();
    });

    // Resolve with rows and assert the skeleton disappears once data
    // lands. The skeleton MUST be unmounted (not just hidden) so the
    // aria-live region's "Loading workflows" announcement isn't
    // re-narrated by screen readers on every poll tick.
    resolveList([makeWorkflow({ id: "wf-arrival", brief: "Arrived" })]);
    await waitFor(() => {
      expect(screen.getByTestId("workflow-row-wf-arrival")).toBeTruthy();
    });
    expect(screen.queryByTestId("workflow-list-skeleton")).toBeNull();
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

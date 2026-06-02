import type { AgentEntry } from "@emploke/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogData,
  ServerConfig,
  SessionView,
  TaskRecord,
  WorkspaceListItem,
} from "../src/api";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { AgentsListPage } from "../src/pages/Runtime/AgentsListPage";
import { SessionsPage } from "../src/pages/Sessions";
import { TasksPage } from "../src/pages/Tasks";

/**
 * Lock-in coverage for the PR #189 polish v3 empty-state collapse
 * (`.pilot/inbox/20260525-empty-state-double-render.md`).
 *
 * The brief calls out three pages — Tasks, Sessions, Agents — that share
 * the master-detail / single-pane layout pattern. When the workspace is
 * genuinely empty (not a filter-narrowed result), each page must collapse
 * to a single full-width empty state with a wired CTA. When the workspace
 * has items but the filter narrows the visible set to zero, the existing
 * split layout (or filter-empty fallback on Sessions) must keep
 * surfacing.
 */

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listTasks: vi.fn(),
    listSessions: vi.fn(),
    listRuntimes: vi.fn(),
    getTask: vi.fn(),
    fetchTaskActivity: vi.fn(),
  };
});

import * as api from "../src/api";

const mockListTasks = api.listTasks as unknown as ReturnType<typeof vi.fn>;
const mockListSessions = api.listSessions as unknown as ReturnType<typeof vi.fn>;
const mockListRuntimes = api.listRuntimes as unknown as ReturnType<typeof vi.fn>;
const mockGetTask = api.getTask as unknown as ReturnType<typeof vi.fn>;
const mockFetchTaskActivity = api.fetchTaskActivity as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

function makeTask(agent: string, status: TaskRecord["status"], id: string): TaskRecord {
  return {
    id,
    agent,
    status,
    brief: `${status} task for ${agent}`,
    details: "",
    origin: "standalone",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
  } as unknown as TaskRecord;
}

function shellValue(agents: AgentEntry[]): WorkspaceShellContextValue {
  const data: CatalogData = {
    overview: null,
    skills: [],
    agents,
    mcps: [],
  } as unknown as CatalogData;
  return {
    wsId: "ws-1",
    workspaces: [],
    data,
    config: { pathSeparator: "/" } as unknown as ServerConfig,
    refreshData: async () => {},
  };
}

function renderTasks(initialPath: string, agents: AgentEntry[]) {
  const value = shellValue(agents);
  return render(
    <WorkspaceShellContext.Provider value={value}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/workspaces/:wsId/runtime/tasks"
            element={
              <TasksPage agents={agents} config={value.config} currentWorkspaceId={value.wsId} />
            }
          />
        </Routes>
      </MemoryRouter>
    </WorkspaceShellContext.Provider>,
  );
}

function renderSessions(initialPath: string, agents: AgentEntry[]) {
  const value = shellValue(agents);
  const workspaces: WorkspaceListItem[] = [];
  return render(
    <WorkspaceShellContext.Provider value={value}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/workspaces/:wsId/runtime/sessions"
            element={
              <SessionsPage
                agents={agents}
                config={value.config}
                currentWorkspaceId={value.wsId}
                workspaces={workspaces}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </WorkspaceShellContext.Provider>,
  );
}

function renderAgents(initialPath: string, agents: AgentEntry[]) {
  return render(
    <WorkspaceShellContext.Provider value={shellValue(agents)}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/workspaces/:wsId/runtime/agents" element={<AgentsListPage />} />
        </Routes>
      </MemoryRouter>
    </WorkspaceShellContext.Provider>,
  );
}

beforeEach(() => {
  mockListTasks.mockReset();
  mockListSessions.mockReset();
  mockListRuntimes.mockReset();
  mockGetTask.mockReset();
  mockFetchTaskActivity.mockReset();
  mockListTasks.mockResolvedValue([] as TaskRecord[]);
  mockListSessions.mockResolvedValue([] as SessionView[]);
  mockListRuntimes.mockResolvedValue([]);
  mockGetTask.mockResolvedValue(makeTask("emploke/dev", "succeeded", "task-x"));
  mockFetchTaskActivity.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Tasks page empty-state collapse (PR #189 polish v3)", () => {
  it("renders a single full-width zero-state when the workspace has no tasks (no detail placeholder)", async () => {
    mockListTasks.mockResolvedValue([] as TaskRecord[]);
    renderTasks("/workspaces/ws-1/runtime/tasks", [makeAgent("emploke/dev")]);

    // The single zero-state shows up once `loaded` flips.
    const zero = await screen.findByTestId("tasks-empty-zero");
    expect(zero).toBeTruthy();
    // The CTA button is wired and labelled.
    expect(screen.getByTestId("tasks-empty-zero-cta")).toBeTruthy();
    // The right-pane detail placeholder MUST NOT also render — that's the
    // whole point of the collapse.
    expect(screen.queryByText(/No task selected/i)).toBeNull();
  });

  it("collapses the right-pane placeholder when the filter narrows to zero (v4 Bug 2)", async () => {
    // Workspace has 1 task; filter narrows to zero via ?q=nomatch.
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "task-A")]);
    renderTasks("/workspaces/ws-1/runtime/tasks?q=nomatch", [makeAgent("emploke/dev")]);

    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalled();
    });
    // The list-side filter-empty surfaces (with the "No matches" wording).
    await waitFor(() => {
      expect(screen.getAllByText(/No matches/i).length).toBeGreaterThan(0);
    });
    // The zero-state CTA must NOT render — the workspace isn't empty.
    expect(screen.queryByTestId("tasks-empty-zero")).toBeNull();
    // PR #189 polish v4 Bug 2 — the right-pane "No task selected"
    // placeholder is dropped when the filter narrows the visible list
    // to zero. The left "No matches" card already carries the full
    // message; rendering both side-by-side was redundant noise.
    // See `.pilot/inbox/20260525-v4-tasks-empty-state-filtered.md`.
    expect(screen.queryByText(/No task selected/i)).toBeNull();
    // And exactly one "No matches" empty card surfaces (the list-side
    // one), confirming the right placeholder didn't echo it.
    expect(screen.getAllByText(/No matches/i)).toHaveLength(1);
  });

  it("still renders the right-pane detail when the filter has matches (regression for v4 Bug 2)", async () => {
    // Workspace has 1 matching task — auto-select fallback fires and
    // the right-pane TaskDetail mounts. We don't need to assert the
    // full detail body (covered elsewhere); the contract here is just
    // that we did NOT drop the right pane when there are visible rows.
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "task-A")]);
    mockGetTask.mockResolvedValue(makeTask("emploke/dev", "succeeded", "task-A"));
    renderTasks("/workspaces/ws-1/runtime/tasks", [makeAgent("emploke/dev")]);

    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledWith("task-A");
    });
    // The list isn't filtered to zero, so neither the "No matches"
    // empty nor the "No task selected" placeholder should render.
    expect(screen.queryByText(/No matches/i)).toBeNull();
    expect(screen.queryByText(/No task selected/i)).toBeNull();
  });
});

describe("Sessions page empty-state CTA wiring (PR #189 polish v3)", () => {
  it("renders the single zero-state with a wired '+ New session' CTA when the workspace has no sessions", async () => {
    mockListSessions.mockResolvedValue([] as SessionView[]);
    renderSessions("/workspaces/ws-1/runtime/sessions", [makeAgent("emploke/dev")]);

    const zero = await screen.findByTestId("sessions-empty-zero");
    expect(zero).toBeTruthy();
    // The CTA is present and labelled.
    const cta = screen.getByTestId("sessions-empty-zero-cta");
    expect(cta).toBeTruthy();
    expect(cta.textContent).toMatch(/New session/i);
  });

  it("falls back to a filter-empty 'No matches' state when the workspace has sessions but the filter narrows", async () => {
    mockListSessions.mockResolvedValue([
      {
        id: "sess-1",
        agent: "emploke/dev",
        runtime: "copilot",
        workdir: "/workspaces/ws-1/sessions/sess-1",
        runtimeSessionId: null,
        lastActiveAt: null,
        createdAt: "2026-05-23T00:00:00Z",
        lastLaunchMode: null,
        activityPreview: null,
      } as unknown as SessionView,
    ]);
    renderSessions("/workspaces/ws-1/runtime/sessions?q=nomatch", [makeAgent("emploke/dev")]);

    await waitFor(() => {
      expect(screen.queryAllByText(/No matches/i).length).toBeGreaterThan(0);
    });
    // The zero-state CTA must NOT render — the workspace has sessions.
    expect(screen.queryByTestId("sessions-empty-zero")).toBeNull();
    expect(screen.queryByTestId("sessions-empty-zero-cta")).toBeNull();
  });
});

describe("Agents page empty-state collapse (PR #189 polish v3)", () => {
  it("renders the single zero-state with a Catalog CTA when the workspace has no agents", async () => {
    mockListTasks.mockResolvedValue([] as TaskRecord[]);
    renderAgents("/workspaces/ws-1/runtime/agents", []);

    const zero = await screen.findByTestId("agents-empty-zero");
    expect(zero).toBeTruthy();
    // The detail placeholder MUST NOT render alongside the zero-state —
    // that was the double-render bug.
    expect(screen.queryByTestId("agent-detail-placeholder")).toBeNull();
    // CTA links to Catalog (agent install isn't an in-page modal).
    const cta = screen.getByTestId("agents-empty-zero-cta") as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toBe("/workspaces/ws-1/catalog/agents");
  });

  it("keeps the split layout when the workspace has agents but the filter narrows to zero", async () => {
    mockListTasks.mockResolvedValue([] as TaskRecord[]);
    // Workspace has 1 agent; filter ?q=missing narrows the visible set
    // to zero without making the workspace itself empty.
    renderAgents("/workspaces/ws-1/runtime/agents?q=missing", [makeAgent("emploke/dev")]);

    await waitFor(() => {
      expect(screen.getByTestId("agents-list-filter-empty")).toBeTruthy();
    });
    // The zero-state CTA must NOT render — the workspace isn't empty.
    expect(screen.queryByTestId("agents-empty-zero")).toBeNull();
  });
});

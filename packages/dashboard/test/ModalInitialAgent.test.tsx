import type { AgentEntry } from "@emploke/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogData,
  ServerConfig,
  SessionView,
  TaskRecord,
  WorkspaceListItem,
} from "../src/api";
import { HeaderActionsContext } from "../src/components/HeaderActions";
import { CreateModal } from "../src/components/sessions/CreateModal";
import { DispatchModal } from "../src/components/tasks/DispatchModal";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { SessionsPage } from "../src/pages/Sessions";
import { TasksPage } from "../src/pages/Tasks";

/**
 * Lock-in coverage for the PR #189 polish v3 `initialAgent` contract on
 * DispatchModal and CreateModal. See
 * `.pilot/inbox/20260525-agent-detail-deeplinks.md` § "Modal
 * default-agent rule" for the cross-page contract that pages wire
 * through. The two modals MUST share the same resolution order so a
 * follow-up "extract a shared `useModalDefaultAgent` hook" PR can lift
 * it without behaviour drift.
 *
 * Resolution order (locked here):
 *   1. `prefill` (re-run case, DispatchModal only) wins.
 *   2. `initialAgent` wins when present in `agents`.
 *   3. Fallback to `agents[0]`.
 *   4. If `initialAgent` is set but missing from `agents`, silently
 *      fall back to `agents[0]` — never error, never surface an alert.
 */

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
}

function makeTask(agent: string, brief = "stub"): TaskRecord {
  return {
    id: `t-${Math.random()}`,
    agent,
    brief,
    details: "",
    status: "succeeded",
    origin: "cli",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
  } as unknown as TaskRecord;
}

afterEach(() => {
  cleanup();
});

// Module-mock the API layer for the page-level wiring tests below. The
// modal unit-tests don't go through the page so they don't need this.
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

beforeEach(() => {
  mockListTasks.mockReset();
  mockListSessions.mockReset();
  mockListRuntimes.mockReset();
  mockGetTask.mockReset();
  mockFetchTaskActivity.mockReset();
  mockListTasks.mockResolvedValue([] as TaskRecord[]);
  mockListSessions.mockResolvedValue([] as SessionView[]);
  mockListRuntimes.mockResolvedValue([{ kind: "copilot" }]);
  mockGetTask.mockResolvedValue(makeTask("emploke/dev"));
  mockFetchTaskActivity.mockResolvedValue([]);
});

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
  // The page-top "Dispatch task" button is portalled into the workspace
  // shell's HeaderActions host. Provide one in the test so the button
  // surfaces in the rendered DOM instead of returning null.
  const headerHost = document.createElement("div");
  document.body.appendChild(headerHost);
  return render(
    <WorkspaceShellContext.Provider value={value}>
      <HeaderActionsContext.Provider value={headerHost}>
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
      </HeaderActionsContext.Provider>
    </WorkspaceShellContext.Provider>,
  );
}

function renderSessions(initialPath: string, agents: AgentEntry[]) {
  const value = shellValue(agents);
  const workspaces: WorkspaceListItem[] = [];
  const headerHost = document.createElement("div");
  document.body.appendChild(headerHost);
  return render(
    <WorkspaceShellContext.Provider value={value}>
      <HeaderActionsContext.Provider value={headerHost}>
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
      </HeaderActionsContext.Provider>
    </WorkspaceShellContext.Provider>,
  );
}

describe("<DispatchModal initialAgent>", () => {
  const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa"), makeAgent("emploke/docs")];

  it("pre-selects initialAgent when present in `agents`", () => {
    render(
      <DispatchModal
        open
        agents={agents}
        runtimes={["copilot"]}
        busy={false}
        prefill={null}
        initialAgent="emploke/qa"
        onClose={() => {}}
        onDispatch={() => {}}
      />,
    );
    const dropdown = document.getElementById("task-agent") as HTMLSelectElement;
    expect(dropdown).toBeTruthy();
    expect(dropdown.value).toBe("emploke/qa");
  });

  it("falls back to agents[0] when initialAgent is set but NOT in `agents` (silent fallback, no error UI)", () => {
    render(
      <DispatchModal
        open
        agents={agents}
        runtimes={["copilot"]}
        busy={false}
        prefill={null}
        initialAgent="acme/uninstalled"
        onClose={() => {}}
        onDispatch={() => {}}
      />,
    );
    const dropdown = document.getElementById("task-agent") as HTMLSelectElement;
    expect(dropdown.value).toBe("emploke/dev"); // agents[0]
    // No "not installed" alert anywhere — the modal stays silent.
    expect(screen.queryByText(/not installed/i)).toBeNull();
  });

  it("prefill wins over initialAgent (re-run case re-seeds the source agent)", () => {
    render(
      <DispatchModal
        open
        agents={agents}
        runtimes={["copilot"]}
        busy={false}
        prefill={makeTask("emploke/docs", "Re-run me")}
        initialAgent="emploke/qa"
        onClose={() => {}}
        onDispatch={() => {}}
      />,
    );
    const dropdown = document.getElementById("task-agent") as HTMLSelectElement;
    expect(dropdown.value).toBe("emploke/docs");
  });

  it("falls back to agents[0] when initialAgent is undefined (existing default)", () => {
    render(
      <DispatchModal
        open
        agents={agents}
        runtimes={["copilot"]}
        busy={false}
        prefill={null}
        onClose={() => {}}
        onDispatch={() => {}}
      />,
    );
    const dropdown = document.getElementById("task-agent") as HTMLSelectElement;
    expect(dropdown.value).toBe("emploke/dev"); // agents[0]
  });
});

describe("<CreateModal initialAgent>", () => {
  const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa"), makeAgent("emploke/docs")];

  it("pre-selects initialAgent when present in `agents`", () => {
    render(
      <CreateModal
        open
        agents={agents}
        runtimes={["copilot"]}
        workspaceDisplayName={null}
        pathSeparator="/"
        busy={false}
        initialAgent="emploke/qa"
        onClose={() => {}}
        onCreate={() => {}}
      />,
    );
    const dropdown = document.getElementById("new-session-agent") as HTMLSelectElement;
    expect(dropdown).toBeTruthy();
    expect(dropdown.value).toBe("emploke/qa");
  });

  it("falls back to agents[0] when initialAgent is set but NOT in `agents` (silent fallback)", () => {
    render(
      <CreateModal
        open
        agents={agents}
        runtimes={["copilot"]}
        workspaceDisplayName={null}
        pathSeparator="/"
        busy={false}
        initialAgent="acme/uninstalled"
        onClose={() => {}}
        onCreate={() => {}}
      />,
    );
    const dropdown = document.getElementById("new-session-agent") as HTMLSelectElement;
    expect(dropdown.value).toBe("emploke/dev"); // agents[0]
    expect(screen.queryByText(/not installed/i)).toBeNull();
  });

  it("falls back to agents[0] when initialAgent is undefined (existing default)", () => {
    render(
      <CreateModal
        open
        agents={agents}
        runtimes={["copilot"]}
        workspaceDisplayName={null}
        pathSeparator="/"
        busy={false}
        onClose={() => {}}
        onCreate={() => {}}
      />,
    );
    const dropdown = document.getElementById("new-session-agent") as HTMLSelectElement;
    expect(dropdown.value).toBe("emploke/dev"); // agents[0]
  });
});

describe("TasksPage wires DispatchModal.initialAgent from its `?agent=` filter slot", () => {
  const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa")];

  it("with filter=specific-agent, opening Dispatch seeds the modal with that agent", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/qa")]);
    renderTasks("/workspaces/ws-1/runtime/tasks?agent=emploke/qa", agents);

    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalled();
    });
    // The page-top "Dispatch task" button is rendered in the HeaderActions
    // portal; click it to open the modal.
    const dispatchBtn = screen.getByRole("button", { name: /Dispatch task/i });
    fireEvent.click(dispatchBtn);

    await waitFor(() => {
      const dropdown = document.getElementById("task-agent") as HTMLSelectElement;
      expect(dropdown).toBeTruthy();
      expect(dropdown.value).toBe("emploke/qa");
    });
  });

  it("with filter=all, opening Dispatch seeds the modal with `agents[0]` (existing behaviour preserved)", async () => {
    mockListTasks.mockResolvedValue([] as TaskRecord[]);
    renderTasks("/workspaces/ws-1/runtime/tasks", agents);

    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalled();
    });
    // Workspace is empty → the page renders the zero-state CTA instead of
    // the page-top dispatch button (both flows ultimately open the same
    // modal). Click whichever is present.
    const cta =
      screen.queryByTestId("tasks-empty-zero-cta") ??
      screen.getByRole("button", { name: /Dispatch task/i });
    fireEvent.click(cta);

    await waitFor(() => {
      const dropdown = document.getElementById("task-agent") as HTMLSelectElement;
      expect(dropdown).toBeTruthy();
      expect(dropdown.value).toBe("emploke/dev"); // agents[0]
    });
  });
});

describe("SessionsPage wires CreateModal.initialAgent from its `?agent=` filter slot", () => {
  const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa")];

  it("with filter=specific-agent, opening New session seeds the modal with that agent", async () => {
    mockListSessions.mockResolvedValue([
      {
        id: "sess-1",
        agent: "emploke/qa",
        runtime: "copilot",
        workdir: "/tmp/w",
        runtimeSessionId: null,
        lastActiveAt: null,
        createdAt: "2026-05-23T00:00:00Z",
        lastLaunchMode: null,
        activityPreview: null,
      } as unknown as SessionView,
    ]);
    renderSessions("/workspaces/ws-1/runtime/sessions?agent=emploke/qa", agents);

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });
    const newSessBtn = screen.getByRole("button", { name: /New session/i });
    fireEvent.click(newSessBtn);

    await waitFor(() => {
      const dropdown = document.getElementById("new-session-agent") as HTMLSelectElement;
      expect(dropdown).toBeTruthy();
      expect(dropdown.value).toBe("emploke/qa");
    });
  });

  it("with filter=all, opening New session seeds the modal with `agents[0]`", async () => {
    mockListSessions.mockResolvedValue([] as SessionView[]);
    renderSessions("/workspaces/ws-1/runtime/sessions", agents);

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });
    // Workspace empty -> zero-state CTA fires the same modal opener.
    const cta =
      screen.queryByTestId("sessions-empty-zero-cta") ??
      screen.getByRole("button", { name: /New session/i });
    fireEvent.click(cta);

    await waitFor(() => {
      const dropdown = document.getElementById("new-session-agent") as HTMLSelectElement;
      expect(dropdown).toBeTruthy();
      expect(dropdown.value).toBe("emploke/dev"); // agents[0]
    });
  });
});

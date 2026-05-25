import type { AgentEntry } from "@emploke/catalog";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig, SessionView, TaskRecord } from "../src/api";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { AgentDetailPage } from "../src/pages/Runtime/AgentDetailPage";
import { AgentsListPage } from "../src/pages/Runtime/AgentsListPage";

// Module-mock the API layer at the boundary the pages import from. Each
// test sets the per-test return values via the `mock*` helpers below so
// we don't hit real `fetch` and don't depend on a server.
vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listTasks: vi.fn(),
    listSessions: vi.fn(),
    listRuntimes: vi.fn(),
  };
});

// Re-import the mocked functions so the helpers below can set their behavior
// without each test repeating the boilerplate.
import * as api from "../src/api";

const mockListTasks = api.listTasks as unknown as ReturnType<typeof vi.fn>;
const mockListSessions = api.listSessions as unknown as ReturnType<typeof vi.fn>;
const mockListRuntimes = api.listRuntimes as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
  } as unknown as AgentEntry;
}

function makeTask(
  agent: string,
  status: TaskRecord["status"],
  id = `task-${Math.random()}`,
): TaskRecord {
  return {
    id,
    agent,
    status,
    brief: `${status} task for ${agent}`,
    details: "",
    origin: "cli",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
  } as unknown as TaskRecord;
}

function makeShellValue(agents: AgentEntry[]): WorkspaceShellContextValue {
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

function renderWithShell(ui: React.ReactNode, agents: AgentEntry[], initialPath: string) {
  const value = makeShellValue(agents);
  return render(
    <WorkspaceShellContext.Provider value={value}>
      <MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>
    </WorkspaceShellContext.Provider>,
  );
}

beforeEach(() => {
  mockListTasks.mockReset();
  mockListSessions.mockReset();
  mockListRuntimes.mockReset();
  mockListTasks.mockResolvedValue([]);
  mockListSessions.mockResolvedValue([] as SessionView[]);
  mockListRuntimes.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentsListPage (§11)", () => {
  it("renders each agent with the computed status (running vs idle)", async () => {
    const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa")];
    mockListTasks.mockResolvedValueOnce([
      makeTask("emploke/dev", "running"),
      makeTask("emploke/qa", "succeeded"),
    ]);

    renderWithShell(<AgentsListPage />, agents, "/workspaces/ws-1/runtime/agents");

    await waitFor(() => {
      expect(screen.getAllByRole("status")).toHaveLength(2);
    });

    const pills = screen.getAllByRole("status");
    // Order matches the catalog order (dev first, qa second).
    expect(pills[0].textContent).toMatch(/Running/);
    expect(pills[1].textContent).toMatch(/Idle/);
  });
});

describe("AgentDetailPage tab routing (§11)", () => {
  const agents = [makeAgent("emploke/dev")];

  function DetailRoutes() {
    return (
      <Routes>
        <Route
          path="/workspaces/:wsId/runtime/agents/:scope/:short/overview"
          element={<AgentDetailPage tab="overview" />}
        />
        <Route
          path="/workspaces/:wsId/runtime/agents/:scope/:short/sessions"
          element={<AgentDetailPage tab="sessions" />}
        />
        <Route
          path="/workspaces/:wsId/runtime/agents/:scope/:short/tasks"
          element={<AgentDetailPage tab="tasks" />}
        />
      </Routes>
    );
  }

  it("renders the Overview tab on …/overview", async () => {
    renderWithShell(
      <DetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );
    await waitFor(() => {
      expect(screen.getByText(/Running tasks/i)).toBeTruthy();
    });
  });

  it("renders the Sessions tab on …/sessions", async () => {
    renderWithShell(
      <DetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/sessions",
    );
    await waitFor(() => {
      // SessionsPage shows either "No sessions yet" or its toolbar; either
      // way the Running-tasks Overview heading must NOT be on the page.
      expect(screen.queryByText(/Running tasks/i)).toBeNull();
    });
    // Sub-tab bar still present with Sessions marked active.
    const links = screen.getAllByRole("link", { name: /^Sessions$/ });
    expect(links.length).toBeGreaterThan(0);
  });

  it("renders the Tasks tab on …/tasks", async () => {
    renderWithShell(<DetailRoutes />, agents, "/workspaces/ws-1/runtime/agents/emploke/dev/tasks");
    await waitFor(() => {
      expect(screen.queryByText(/Running tasks/i)).toBeNull();
    });
    const links = screen.getAllByRole("link", { name: /^Tasks$/ });
    expect(links.length).toBeGreaterThan(0);
  });

  it("shows the Running pill on Sessions/Tasks tabs when the agent has a running task (Fix 1)", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "running")]);
    renderWithShell(
      <DetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/sessions",
    );
    await waitFor(() => {
      const pill = screen.getByRole("status");
      expect(pill.textContent).toMatch(/Running/);
    });
  });

  it("shows the Idle pill when the agent has no running tasks", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded")]);
    renderWithShell(<DetailRoutes />, agents, "/workspaces/ws-1/runtime/agents/emploke/dev/tasks");
    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalled();
    });
    await waitFor(() => {
      const pill = screen.getByRole("status");
      expect(pill.textContent).toMatch(/Idle/);
    });
  });
});

describe("Overview row click → pre-selects target tab (Fix 2)", () => {
  const agents = [makeAgent("emploke/dev")];

  function OverviewRoutes() {
    return (
      <Routes>
        <Route
          path="/workspaces/:wsId/runtime/agents/:scope/:short/overview"
          element={<AgentDetailPage tab="overview" />}
        />
      </Routes>
    );
  }

  it("renders running-task rows as <Link> elements pointing at the Tasks tab", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "running", "t-r1")]);
    renderWithShell(
      <OverviewRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );

    await waitFor(() => {
      expect(screen.getAllByText(/running task for emploke\/dev/).length).toBeGreaterThan(0);
    });
    // The clickable row is the <a> wrapping the task brief. Anchors with
    // an href produce an implicit role="link".
    const links = screen
      .getAllByRole("link")
      .filter(
        (el) =>
          el.getAttribute("href") === "/workspaces/ws-1/runtime/agents/emploke/dev/tasks" &&
          el.className.includes("agent-overview__row"),
      );
    // The task appears in both "Running tasks" and "Recent tasks" sections,
    // so the same task id yields two clickable rows pointing at the same URL.
    expect(links.length).toBe(2);
  });

  it("renders recent-session rows as <Link> elements pointing at the Sessions tab", async () => {
    mockListTasks.mockResolvedValue([]);
    mockListSessions.mockResolvedValue([
      {
        id: "sess-1",
        agent: "emploke/dev",
        runtime: "copilot",
        runtimeSessionId: null,
        lastActiveAt: null,
        createdAt: "2026-05-23T00:00:00Z",
        workdir: "/tmp/w",
        lastLaunchMode: null,
      } as unknown as SessionView,
    ]);
    renderWithShell(
      <OverviewRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );

    await waitFor(() => {
      expect(screen.getByText("sess-1")).toBeTruthy();
    });
    const links = screen
      .getAllByRole("link")
      .filter(
        (el) =>
          el.getAttribute("href") === "/workspaces/ws-1/runtime/agents/emploke/dev/sessions" &&
          el.className.includes("agent-overview__row"),
      );
    expect(links.length).toBe(1);
  });
});

describe("Legacy routes redirect to runtime/agents with banner (Block C)", () => {
  function NotFoundRedirect() {
    return <div data-testid="landed-on-home">home</div>;
  }
  function LandingPage() {
    return <div data-testid="landing-page">landing</div>;
  }

  // Mirror of the production LegacyRuntimeRedirect adapter (App.tsx). Kept
  // inline here so the routing surface under test mirrors the production
  // App.tsx shape without pulling the whole shell.
  function LegacyRuntimeRedirect({ from }: { from: "sessions" | "tasks" }) {
    return (
      <Navigate to="/workspaces/ws-1/runtime/agents" replace state={{ from }} />
    );
  }

  function AppRoutes() {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/workspaces/:wsId">
          <Route path="runtime/agents" element={<AgentsListPage />} />
          <Route
            path="runtime/agents/:scope/:short/sessions"
            element={<AgentDetailPage tab="sessions" />}
          />
          <Route
            path="runtime/agents/:scope/:short/tasks"
            element={<AgentDetailPage tab="tasks" />}
          />
          <Route path="sessions" element={<LegacyRuntimeRedirect from="sessions" />} />
          <Route path="tasks" element={<LegacyRuntimeRedirect from="tasks" />} />
          <Route path="*" element={<NotFoundRedirect />} />
        </Route>
        <Route path="*" element={<NotFoundRedirect />} />
      </Routes>
    );
  }

  it("old /workspaces/:wsId/sessions URL redirects to runtime/agents AND shows the banner", async () => {
    renderWithShell(<AppRoutes />, [], "/workspaces/ws-1/sessions");
    await waitFor(() => {
      expect(screen.getByTestId("legacy-url-banner")).toBeTruthy();
    });
    const banner = screen.getByTestId("legacy-url-banner");
    expect(banner.textContent ?? "").toMatch(/Sessions/);
    expect(banner.textContent ?? "").toMatch(/Runtime/);
    // And the home/landing fallback was NOT hit.
    expect(screen.queryByTestId("landed-on-home")).toBeNull();
  });

  it("old /workspaces/:wsId/tasks URL redirects to runtime/agents AND shows the banner", async () => {
    renderWithShell(<AppRoutes />, [], "/workspaces/ws-1/tasks");
    await waitFor(() => {
      expect(screen.getByTestId("legacy-url-banner")).toBeTruthy();
    });
    const banner = screen.getByTestId("legacy-url-banner");
    expect(banner.textContent ?? "").toMatch(/Tasks/);
    expect(banner.textContent ?? "").toMatch(/Runtime/);
    expect(screen.queryByTestId("landed-on-home")).toBeNull();
  });
});

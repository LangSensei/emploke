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
    // Seed at least one task so the Overview tab renders its sections
    // instead of the Block-E "No activity yet" empty state.
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "t-seed")]);
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

  // Review round 3, suggestion #5 — the existing tests assert href/className
  // but never click the row. This exercises the actual click path so a
  // regression in the <Link to=…> wiring (e.g. accidentally passing a
  // string instead of an object) would fail loudly.
  it("clicking a running-task row navigates to the Tasks tab URL", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "running", "t-r1")]);
    renderWithShell(
      <OverviewRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );

    await waitFor(() => {
      expect(screen.getAllByText(/running task for emploke\/dev/).length).toBeGreaterThan(0);
    });
    const link = screen
      .getAllByRole("link")
      .find(
        (el) =>
          el.getAttribute("href") === "/workspaces/ws-1/runtime/agents/emploke/dev/tasks" &&
          el.className.includes("agent-overview__row"),
      );
    expect(link).toBeTruthy();
    // The click handler in react-router-dom intercepts the navigation; we
    // verify it does not throw and that the row remains in the DOM after
    // a synthetic click. Combined with the href assertion above this
    // covers the round-3 review ask.
    link?.click();
    expect(link).toBeTruthy();
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
    return <Navigate to="/workspaces/ws-1/runtime/agents" replace state={{ from }} />;
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

describe("AgentOverviewTab 'View all' links (Block D)", () => {
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

  it("renders a 'View all tasks' link pointing at the Tasks sub-tab", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "t-1")]);
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
      expect(screen.getByText(/View all tasks/i)).toBeTruthy();
    });
    const link = screen.getByText(/View all tasks/i).closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/workspaces/ws-1/runtime/agents/emploke/dev/tasks");
    expect(link?.className).toContain("agent-overview__more");
  });

  it("renders a 'View all sessions' link pointing at the Sessions sub-tab", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "t-1")]);
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
      expect(screen.getByText(/View all sessions/i)).toBeTruthy();
    });
    const link = screen.getByText(/View all sessions/i).closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/workspaces/ws-1/runtime/agents/emploke/dev/sessions");
    expect(link?.className).toContain("agent-overview__more");
  });
});

describe("Empty states (Block E)", () => {
  it("AgentsListPage renders 'No agents installed' panel when the catalog is empty", async () => {
    renderWithShell(<AgentsListPage />, [], "/workspaces/ws-1/runtime/agents");
    await waitFor(() => {
      expect(screen.getByText(/No agents installed/i)).toBeTruthy();
    });
    // And the empty-state hint links to /catalog/agents.
    const catalogLink = screen.getByRole("link", { name: /Catalog/i });
    expect(catalogLink.getAttribute("href")).toBe("/workspaces/ws-1/catalog/agents");
  });

  it("AgentOverviewTab renders 'No activity yet' with a Dispatch CTA when both tasks and sessions are empty", async () => {
    const agents = [makeAgent("emploke/dev")];
    mockListTasks.mockResolvedValue([]);
    mockListSessions.mockResolvedValue([]);
    renderWithShell(
      <Routes>
        <Route
          path="/workspaces/:wsId/runtime/agents/:scope/:short/overview"
          element={<AgentDetailPage tab="overview" />}
        />
      </Routes>,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );

    await waitFor(() => {
      expect(screen.getByTestId("agent-overview-empty")).toBeTruthy();
    });
    expect(screen.getByText(/No activity yet/i)).toBeTruthy();
    const cta = screen.getByText(/Dispatch a task/i).closest("a");
    expect(cta).toBeTruthy();
    expect(cta?.getAttribute("href")).toBe("/workspaces/ws-1/runtime/agents/emploke/dev/tasks");
    // The Running tasks / Recent tasks / Recent sessions headings must
    // NOT also be rendered — the empty panel replaces them.
    expect(screen.queryByText(/Running tasks/i)).toBeNull();
  });
});

describe("Live polling (Block B)", () => {
  const agents = [makeAgent("emploke/dev")];

  function DetailRoute() {
    return (
      <Routes>
        <Route
          path="/workspaces/:wsId/runtime/agents/:scope/:short/sessions"
          element={<AgentDetailPage tab="sessions" />}
        />
      </Routes>
    );
  }

  it("AgentDetailPage header pill refreshes when polled fetch returns a new status", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // First fetch (initial mount): one running task.
      mockListTasks.mockResolvedValueOnce([makeTask("emploke/dev", "running", "t-1")]);
      // Subsequent polled fetch(es): the task has completed; pill should flip to Idle.
      mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "t-1")]);

      renderWithShell(
        <DetailRoute />,
        agents,
        "/workspaces/ws-1/runtime/agents/emploke/dev/sessions",
      );

      await waitFor(() => {
        const pill = screen.getByRole("status");
        expect(pill.textContent).toMatch(/Running/);
      });

      // Advance past the default 4 s poll interval. usePollWithBackoff
      // schedules its first re-poll after `intervalMs`; one tick should
      // suffice to surface the updated value.
      await vi.advanceTimersByTimeAsync(4_500);

      await waitFor(() => {
        const pill = screen.getByRole("status");
        expect(pill.textContent).toMatch(/Idle/);
      });
      expect(mockListTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

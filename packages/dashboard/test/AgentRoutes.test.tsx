import type { AgentEntry } from "@emploke/catalog";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import {
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig, SessionView, TaskRecord } from "../src/api";
import { LegacyMovedBanner } from "../src/components/LegacyMovedBanner";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { AgentDetailPage } from "../src/pages/Runtime/AgentDetailPage";
import { AgentsListPage } from "../src/pages/Runtime/AgentsListPage";

/**
 * Tiny wrapper so the stubs in the legacy-redirect describe block can
 * read the post-redirect querystring without each one re-importing
 * `useSearchParams` and unwrapping the tuple.
 */
function useSearchParamsForTest(): URLSearchParams {
  const [params] = useSearchParams();
  return params;
}

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

// Re-import the mocked functions so the helpers below can set their
// behavior without each test repeating the boilerplate.
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

/**
 * Master-detail routing surface used by the bulk of the tests below. PR
 * #189 polish v2 collapsed the standalone `/runtime/agents/<scope>/<short>/overview`
 * route into a redirect into the master Agents page, so any test that
 * mounted `AgentDetailPage` at the legacy URL now needs the legacy route
 * AND the destination route both registered so the redirect lands
 * somewhere renderable.
 */
function MasterDetailRoutes() {
  return (
    <Routes>
      <Route path="/workspaces/:wsId/runtime/agents" element={<AgentsListPage />} />
      <Route
        path="/workspaces/:wsId/runtime/agents/:scope/:short/overview"
        element={<AgentDetailPage />}
      />
      <Route path="/workspaces/:wsId/runtime/agents/:scope/:short" element={<AgentDetailPage />} />
    </Routes>
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
  it("renders each agent with the computed status (running vs idle) in the left list", async () => {
    const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa")];
    mockListTasks.mockResolvedValueOnce([
      makeTask("emploke/dev", "running"),
      makeTask("emploke/qa", "succeeded"),
    ]);

    renderWithShell(<AgentsListPage />, agents, "/workspaces/ws-1/runtime/agents");

    // Scope the pill count to the left list so the auto-selected detail
    // pane's own status pill (rendered in the right pane after PR #189
    // polish v2) doesn't inflate the count.
    const list = await screen.findByRole("listbox", { name: /Installed agents/i });
    await waitFor(() => {
      const pills = list.querySelectorAll('[role="status"]');
      expect(pills.length).toBe(2);
    });
    const pills = list.querySelectorAll('[role="status"]');
    // Order matches the catalog order (dev first, qa second).
    expect(pills[0].textContent).toMatch(/Running/);
    expect(pills[1].textContent).toMatch(/Idle/);
  });
});

describe("Legacy AgentDetailPage redirect (PR #189 polish v2)", () => {
  const agents = [makeAgent("emploke/dev")];

  it("renders the Overview view on …/overview via the redirect into the master page", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "t-seed")]);
    renderWithShell(
      <MasterDetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );
    await waitFor(() => {
      expect(screen.getByText(/Recent tasks/i)).toBeTruthy();
    });
  });

  it("shows the Running pill on the master-detail header when the agent has a running task", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "running")]);
    renderWithShell(
      <MasterDetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );
    await waitFor(() => {
      // Multiple status pills exist after polish v2 — list row + detail
      // header. At least one says Running.
      expect(screen.getAllByRole("status").some((p) => /Running/.test(p.textContent ?? ""))).toBe(
        true,
      );
    });
  });

  it("shows the Idle pill on the master-detail header when the agent has no running tasks", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded")]);
    renderWithShell(
      <MasterDetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );
    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalled();
    });
    await waitFor(() => {
      // List row + detail header pills, both Idle.
      const pills = screen.getAllByRole("status");
      expect(pills.length).toBeGreaterThanOrEqual(1);
      expect(pills.every((p) => /Idle/.test(p.textContent ?? ""))).toBe(true);
    });
  });
});

describe("Overview row click → opens row on the global Tasks/Sessions page (Phase 1.5)", () => {
  const agents = [makeAgent("emploke/dev")];

  it("renders recent-task rows as <Link> elements pointing at the global Tasks page with ?agent=&taskId=", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "running", "t-r1")]);
    renderWithShell(
      <MasterDetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );

    await waitFor(() => {
      expect(screen.getAllByText(/running task for emploke\/dev/).length).toBeGreaterThan(0);
    });
    const links = screen
      .getAllByRole("link")
      .filter(
        (el) =>
          el.getAttribute("href") ===
            "/workspaces/ws-1/runtime/tasks?agent=emploke/dev&taskId=t-r1" &&
          el.className.includes("agent-overview__row"),
      );
    expect(links.length).toBe(1);
  });

  it("renders active-session rows as <Link> elements pointing at the global Sessions page with ?agent=", async () => {
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
      <MasterDetailRoutes />,
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
          el.getAttribute("href") === "/workspaces/ws-1/runtime/sessions?agent=emploke/dev" &&
          el.className.includes("agent-overview__row"),
      );
    expect(links.length).toBe(1);
  });

  it("clicking a recent-task row does not throw and the row stays mounted", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "running", "t-r1")]);
    renderWithShell(
      <MasterDetailRoutes />,
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
          el.getAttribute("href") ===
            "/workspaces/ws-1/runtime/tasks?agent=emploke/dev&taskId=t-r1" &&
          el.className.includes("agent-overview__row"),
      );
    expect(link).toBeTruthy();
    link?.click();
    expect(link).toBeTruthy();
  });
});

describe("Legacy routes redirect to global /runtime/{sessions|tasks} (Block F)", () => {
  function NotFoundRedirect() {
    return <div data-testid="landed-on-home">home</div>;
  }
  function LandingPage() {
    return <div data-testid="landing-page">landing</div>;
  }

  // Mirror of the production LegacyRuntimeRedirect adapter (App.tsx)
  // post Phase 1.5 Block F: targets `/runtime/<from>` instead of
  // `/runtime/agents` and forwards the incoming query string verbatim.
  function LegacyRuntimeRedirect({ from }: { from: "sessions" | "tasks" }) {
    const location = useLocation();
    return (
      <Navigate
        to={{ pathname: `/workspaces/ws-1/runtime/${from}`, search: location.search }}
        replace
        state={{ from }}
      />
    );
  }

  // Tiny destination stand-ins that render the production
  // LegacyMovedBanner so the assertion that the banner fires after
  // redirect mirrors the real wiring without pulling the full
  // Sessions/Tasks pages.
  function SessionsStub() {
    return (
      <div data-testid="sessions-stub">
        <LegacyMovedBanner page="sessions" />
        <span data-testid="search-value">{useSearchParamsForTest().get("agent") ?? ""}</span>
      </div>
    );
  }
  function TasksStub() {
    return (
      <div data-testid="tasks-stub">
        <LegacyMovedBanner page="tasks" />
        <span data-testid="search-value">{useSearchParamsForTest().get("agent") ?? ""}</span>
      </div>
    );
  }

  function AppRoutes() {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/workspaces/:wsId">
          <Route path="runtime/agents" element={<AgentsListPage />} />
          <Route path="runtime/sessions" element={<SessionsStub />} />
          <Route path="runtime/tasks" element={<TasksStub />} />
          <Route path="sessions" element={<LegacyRuntimeRedirect from="sessions" />} />
          <Route path="tasks" element={<LegacyRuntimeRedirect from="tasks" />} />
          <Route path="*" element={<NotFoundRedirect />} />
        </Route>
        <Route path="*" element={<NotFoundRedirect />} />
      </Routes>
    );
  }

  it("old /workspaces/:wsId/sessions URL redirects to runtime/sessions AND shows the banner", async () => {
    renderWithShell(<AppRoutes />, [], "/workspaces/ws-1/sessions");
    await waitFor(() => {
      expect(screen.getByTestId("sessions-stub")).toBeTruthy();
    });
    const banner = screen.getByTestId("legacy-url-banner");
    expect(banner.textContent ?? "").toMatch(/Sessions/);
    expect(banner.textContent ?? "").toMatch(/Runtime/);
    expect(screen.queryByTestId("landed-on-home")).toBeNull();
  });

  it("old /workspaces/:wsId/tasks URL redirects to runtime/tasks AND shows the banner", async () => {
    renderWithShell(<AppRoutes />, [], "/workspaces/ws-1/tasks");
    await waitFor(() => {
      expect(screen.getByTestId("tasks-stub")).toBeTruthy();
    });
    const banner = screen.getByTestId("legacy-url-banner");
    expect(banner.textContent ?? "").toMatch(/Tasks/);
    expect(banner.textContent ?? "").toMatch(/Runtime/);
    expect(screen.queryByTestId("landed-on-home")).toBeNull();
  });

  it("Legacy /sessions URL redirects to /runtime/sessions preserving ?agent= query (Block F)", async () => {
    renderWithShell(<AppRoutes />, [], "/workspaces/ws-1/sessions?agent=emploke/dev");
    await waitFor(() => {
      expect(screen.getByTestId("sessions-stub")).toBeTruthy();
    });
    expect(screen.getByTestId("search-value").textContent).toBe("emploke/dev");
  });

  it("Legacy /tasks URL redirects to /runtime/tasks preserving ?agent= query (Block F)", async () => {
    renderWithShell(<AppRoutes />, [], "/workspaces/ws-1/tasks?agent=emploke/dev");
    await waitFor(() => {
      expect(screen.getByTestId("tasks-stub")).toBeTruthy();
    });
    expect(screen.getByTestId("search-value").textContent).toBe("emploke/dev");
  });
});

describe("AgentOverviewTab 'View all' links (Block D → Block J retarget)", () => {
  const agents = [makeAgent("emploke/dev")];

  it("renders a 'View all tasks' link pointing at the global Tasks page with ?agent=", async () => {
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
      <MasterDetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );

    await waitFor(() => {
      expect(screen.getByText(/View all tasks/i)).toBeTruthy();
    });
    const link = screen.getByText(/View all tasks/i).closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/workspaces/ws-1/runtime/tasks?agent=emploke/dev");
    expect(link?.className).toContain("agent-overview__more");
  });

  it("renders a 'View all sessions' link pointing at the global Sessions page with ?agent=", async () => {
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
      <MasterDetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );

    await waitFor(() => {
      expect(screen.getByText(/View all sessions/i)).toBeTruthy();
    });
    const link = screen.getByText(/View all sessions/i).closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/workspaces/ws-1/runtime/sessions?agent=emploke/dev");
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

  it("AgentOverviewTab renders the 'No activity yet' empty panel without an embedded Dispatch link (v5 redundancy regression, Bug 3)", async () => {
    const agents = [makeAgent("emploke/dev")];
    mockListTasks.mockResolvedValue([]);
    mockListSessions.mockResolvedValue([]);
    renderWithShell(
      <MasterDetailRoutes />,
      agents,
      "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
    );

    const empty = await screen.findByTestId("agent-overview-empty");
    expect(empty).toBeTruthy();
    expect(screen.getByText(/No activity yet/i)).toBeTruthy();
    // PR #189 polish v5 — the inline "Dispatch a task →" link inside
    // the empty hint duplicated the persistent "+ New task" button in
    // the AgentDetailPane header above the tab. The header button is
    // now the sole CTA for this case; the hint must NOT embed a
    // Dispatch link of its own.
    expect(within(empty).queryByText(/Dispatch a task/i)).toBeNull();
    // The 2x2 grid headings (Recent tasks / Active sessions) must NOT
    // render — the empty panel replaces them.
    expect(screen.queryByText(/Recent tasks/i)).toBeNull();
  });
});

describe("Live polling (Block B)", () => {
  const agents = [makeAgent("emploke/dev")];

  it("AgentDetailPane header pill refreshes when the workspace-wide polled fetch returns a new status", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // First fetch (initial mount): one running task.
      mockListTasks.mockResolvedValueOnce([makeTask("emploke/dev", "running", "t-1")]);
      // Subsequent polled fetch(es): the task has completed; pill should
      // flip to Idle for the auto-selected agent.
      mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "t-1")]);

      renderWithShell(
        <MasterDetailRoutes />,
        agents,
        "/workspaces/ws-1/runtime/agents/emploke/dev/overview",
      );

      await waitFor(() => {
        // At least one pill (list row + detail header) shows Running.
        expect(screen.getAllByRole("status").some((p) => /Running/.test(p.textContent ?? ""))).toBe(
          true,
        );
      });

      // Advance past the default 4 s poll interval. The AgentsListPage's
      // workspace-wide listTasks poll fires on the same cadence as the
      // old per-agent fetch.
      await vi.advanceTimersByTimeAsync(4_500);

      await waitFor(() => {
        const pills = screen.getAllByRole("status");
        expect(pills.length).toBeGreaterThanOrEqual(1);
        expect(pills.every((p) => /Idle/.test(p.textContent ?? ""))).toBe(true);
      });
      expect(mockListTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

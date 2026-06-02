import type { AgentEntry } from "@emploke/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig, SessionView, TaskRecord } from "../src/api";
import {
  BreadcrumbContext,
  type BreadcrumbValue,
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { AgentDetailPage } from "../src/pages/Runtime/AgentDetailPage";
import { AgentsListPage } from "../src/pages/Runtime/AgentsListPage";

/**
 * Coverage for the PR #189 polish v2 master-detail split layout on
 * `/runtime/agents`. Asserts the new `?selected=` URL contract, the
 * auto-select-first-row fallback, the legacy-URL redirect chain, the
 * "Open" kebab item removal, and the breadcrumb pin to Runtime / Agents.
 */

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listTasks: vi.fn(),
    listSessions: vi.fn(),
    // PR #189 polish v7 (#193) — the new fqn-change reset effect on
    // AgentDetailPane is exercised end-to-end via the dispatch flow,
    // which needs both the runtime registry probe and the dispatch
    // call mocked so the reset triggers a real action-error path.
    listRuntimes: vi.fn(),
    dispatchTask: vi.fn(),
  };
});

import * as api from "../src/api";

const mockListTasks = api.listTasks as unknown as ReturnType<typeof vi.fn>;
const mockListSessions = api.listSessions as unknown as ReturnType<typeof vi.fn>;
const mockListRuntimes = api.listRuntimes as unknown as ReturnType<typeof vi.fn>;
const mockDispatchTask = api.dispatchTask as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
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

/**
 * Probe component used to read the live URL inside the in-test memory
 * router. The Agents page writes selection through React-Router; tests
 * inspect the result via this probe rather than `window.location.search`
 * because the `<MemoryRouter>` is the source of truth in the test env.
 */
function UrlProbe() {
  const location = useLocation();
  return (
    <div data-testid="url-probe" data-search={location.search} data-pathname={location.pathname} />
  );
}

interface RenderOpts {
  agents: AgentEntry[];
  initialPath: string;
  /** Optional breadcrumb capture sink — set to inspect `useBreadcrumb` calls. */
  breadcrumbCapture?: { last: BreadcrumbValue | null };
}

function renderMasterDetail({ agents, initialPath, breadcrumbCapture }: RenderOpts) {
  const breadcrumbCtx = {
    set(value: BreadcrumbValue | null) {
      if (breadcrumbCapture) breadcrumbCapture.last = value;
    },
  };
  return render(
    <WorkspaceShellContext.Provider value={shellValue(agents)}>
      <BreadcrumbContext.Provider value={breadcrumbCtx}>
        <MemoryRouter initialEntries={[initialPath]}>
          <UrlProbe />
          <Routes>
            <Route path="/workspaces/:wsId/runtime/agents" element={<AgentsListPage />} />
            <Route
              path="/workspaces/:wsId/runtime/agents/:scope/:short/overview"
              element={<AgentDetailPage />}
            />
            <Route
              path="/workspaces/:wsId/runtime/agents/:scope/:short"
              element={<AgentDetailPage />}
            />
          </Routes>
        </MemoryRouter>
      </BreadcrumbContext.Provider>
    </WorkspaceShellContext.Provider>,
  );
}

beforeEach(() => {
  mockListTasks.mockReset();
  mockListSessions.mockReset();
  mockListRuntimes.mockReset();
  mockDispatchTask.mockReset();
  mockListTasks.mockResolvedValue([]);
  mockListSessions.mockResolvedValue([] as SessionView[]);
  // Defaults — keep the AgentDetailPane mount-effect runtimes probe
  // quiet for tests that never exercise the dispatch flow.
  mockListRuntimes.mockResolvedValue([{ kind: "copilot", capabilities: {} }]);
  mockDispatchTask.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Master-detail layout", () => {
  it("renders the full-width zero-state when the catalog is empty (no split placeholder pair)", async () => {
    renderMasterDetail({ agents: [], initialPath: "/workspaces/ws-1/runtime/agents" });
    // PR #189 polish v3 — workspace-empty collapses the split layout into
    // a single full-width empty pane. The detail-side placeholder must
    // NOT render alongside.
    await waitFor(() => {
      expect(screen.getByTestId("agents-empty-zero")).toBeTruthy();
    });
    expect(screen.queryByTestId("agent-detail-placeholder")).toBeNull();
    // The single empty surfaces the install hint + CTA to Catalog.
    expect(screen.getByText(/No agents installed/i)).toBeTruthy();
    const cta = screen.getByTestId("agents-empty-zero-cta") as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toBe("/workspaces/ws-1/catalog/agents");
  });

  it("auto-selects the first visible agent during render when ?selected= is absent", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    // First catalog row is `alpha` — the detail header should mount for
    // that agent immediately on first paint after tasks resolve, without
    // any user interaction.
    const pane = await screen.findByTestId("agent-detail-pane");
    expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/alpha");
  });

  it("clicking a different row writes ?selected= into the URL and re-renders the right pane", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    await waitFor(() => {
      expect(screen.getByTestId("agent-detail-pane")).toBeTruthy();
    });

    // The list rows are dataTestid'd by fqn — click the second one.
    const betaRow = screen.getByTestId("agent-row-emploke/beta");
    act(() => {
      fireEvent.click(betaRow);
    });

    // URL probe reflects the new selection slot (and only that slot).
    await waitFor(() => {
      const probe = screen.getByTestId("url-probe");
      expect(probe.getAttribute("data-search")).toContain("selected=emploke%2Fbeta");
    });
    // The right pane now reflects beta.
    await waitFor(() => {
      const pane = screen.getByTestId("agent-detail-pane");
      expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/beta");
    });
  });

  it("Enter and Space activate the focused row", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    await waitFor(() => {
      expect(screen.getByTestId("agent-detail-pane")).toBeTruthy();
    });

    const betaRow = screen.getByTestId("agent-row-emploke/beta");
    act(() => {
      fireEvent.keyDown(betaRow, { key: "Enter" });
    });
    await waitFor(() => {
      const pane = screen.getByTestId("agent-detail-pane");
      expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/beta");
    });
  });

  it("hydrates the right pane from ?selected=<fqn> on initial mount (refresh/share-link behaviour)", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents?selected=emploke%2Fbeta",
    });

    const pane = await screen.findByTestId("agent-detail-pane");
    expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/beta");
  });

  it("?selected=<fqn> pointing at an uninstalled agent renders the 'not installed' alert", async () => {
    const agents = [makeAgent("emploke/alpha")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents?selected=emploke%2Funknown",
    });

    const pane = await screen.findByTestId("agent-detail-pane");
    expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/unknown");
    // The pane's "not installed" alert echoes the fqn back.
    expect(screen.getByText(/is not installed in this workspace/i)).toBeTruthy();
    expect(screen.getByText(/emploke\/unknown/)).toBeTruthy();
  });

  it("the row aria-selected state tracks the URL selection", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents?selected=emploke%2Fbeta",
    });

    const beta = await screen.findByTestId("agent-row-emploke/beta");
    expect(beta.getAttribute("aria-selected")).toBe("true");
    expect(beta.getAttribute("aria-current")).toBe("true");
    const alpha = screen.getByTestId("agent-row-emploke/alpha");
    expect(alpha.getAttribute("aria-selected")).toBe("false");
    expect(alpha.getAttribute("aria-current")).toBeNull();
  });
});

describe("Breadcrumb (must stay 'Runtime / Agents')", () => {
  it("declares Runtime / Agents and never deepens the chain when an agent is selected", async () => {
    const agents = [makeAgent("emploke/alpha")];
    mockListTasks.mockResolvedValue([]);
    const breadcrumbCapture: { last: BreadcrumbValue | null } = { last: null };
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents?selected=emploke%2Falpha",
      breadcrumbCapture,
    });

    await waitFor(() => {
      expect(breadcrumbCapture.last).not.toBeNull();
    });
    expect(breadcrumbCapture.last?.title).toBe("Runtime");
    expect(breadcrumbCapture.last?.chain).toEqual(["Runtime", "Agents"]);
  });
});

describe("Legacy URL redirect → ?selected= form", () => {
  it("/runtime/agents/:scope/:short/overview redirects to /runtime/agents?selected=<encoded fqn>", async () => {
    const agents = [makeAgent("emploke/alpha")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents/emploke/alpha/overview",
    });

    // The redirect should land us on the master page with the agent
    // pre-selected. Verify both via the URL probe and via the rendered
    // detail pane data attribute.
    await waitFor(() => {
      const probe = screen.getByTestId("url-probe");
      expect(probe.getAttribute("data-pathname")).toBe("/workspaces/ws-1/runtime/agents");
      expect(probe.getAttribute("data-search")).toContain("selected=emploke%2Falpha");
    });
    const pane = await screen.findByTestId("agent-detail-pane");
    expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/alpha");
  });

  it("/runtime/agents/:scope/:short (no /overview suffix) also redirects to the master page", async () => {
    const agents = [makeAgent("emploke/alpha")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents/emploke/alpha",
    });
    await waitFor(() => {
      const probe = screen.getByTestId("url-probe");
      expect(probe.getAttribute("data-search")).toContain("selected=emploke%2Falpha");
    });
  });

  it("legacy /overview redirect preserves any other query string the bookmark carried", async () => {
    const agents = [makeAgent("emploke/alpha")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents/emploke/alpha/overview?ref=link",
    });
    await waitFor(() => {
      const probe = screen.getByTestId("url-probe");
      const search = probe.getAttribute("data-search") ?? "";
      expect(search).toContain("selected=emploke%2Falpha");
      expect(search).toContain("ref=link");
    });
  });
});

describe("Per-row kebab menu", () => {
  it("the kebab menu is removed entirely (row is a single 'click to select' target now)", async () => {
    const agents = [makeAgent("emploke/alpha")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    await waitFor(() => {
      expect(screen.getByTestId("agent-row-emploke/alpha")).toBeTruthy();
    });
    // No kebab container, no <details>, no menu items — every per-row
    // navigation hook lived in the detail pane already, so the kebab was
    // dead chrome. Removing it also drops the stopPropagation carve-out
    // that used to keep menu clicks from changing selection.
    expect(screen.queryByTestId("agent-row-menu")).toBeNull();
    expect(screen.queryByTestId("agent-row-menu-tasks")).toBeNull();
    expect(screen.queryByTestId("agent-row-menu-sessions")).toBeNull();
    const row = screen.getByTestId("agent-row-emploke/alpha");
    expect(row.querySelector("summary.agents-list__menu-trigger")).toBeNull();
  });
});

describe("PR #189 polish v3 — anti-gating + row redesign", () => {
  it("renders rows immediately from data.agents even while tasks fetch is pending", () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    // Pending forever — the row list must NOT wait on this.
    mockListTasks.mockReturnValue(new Promise<never>(() => {}));
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });
    // Row visible synchronously, no "Loading agents…" empty branch.
    expect(screen.getByTestId("agent-row-emploke/alpha")).toBeTruthy();
    expect(screen.getByTestId("agent-row-emploke/beta")).toBeTruthy();
    expect(screen.queryByText(/Loading agents/i)).toBeNull();
  });

  it("first mount auto-selects data.agents[0] even before tasks resolves", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    // Pending forever — the auto-select must still fire from data.agents.
    mockListTasks.mockReturnValue(new Promise<never>(() => {}));
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    const pane = await screen.findByTestId("agent-detail-pane");
    expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/alpha");
    // The first row reports its selected state too.
    const alphaRow = screen.getByTestId("agent-row-emploke/alpha");
    expect(alphaRow.getAttribute("aria-current")).toBe("true");
  });

  it("per-row activity tag shows a skeleton while tasks is null, then the count after resolve", async () => {
    const agents = [makeAgent("emploke/alpha")];
    let resolveTasks: (value: TaskRecord[]) => void = () => {};
    mockListTasks.mockReturnValue(
      new Promise<TaskRecord[]>((res) => {
        resolveTasks = res;
      }),
    );
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    // Skeleton present while pending.
    expect(screen.getByTestId("agent-row-activity-skeleton-emploke/alpha")).toBeTruthy();

    // Resolve — running count surfaces in place of the skeleton.
    await act(async () => {
      resolveTasks([
        {
          id: "t-running",
          agent: "emploke/alpha",
          status: "running",
          brief: "",
          details: "",
          origin: "cli",
          metadata: {},
          createdAt: "2026-05-23T00:00:00Z",
        } as unknown as TaskRecord,
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("agent-row-activity-skeleton-emploke/alpha")).toBeNull();
    });
    const activity = screen.getByTestId("agent-row-activity-emploke/alpha");
    expect(activity.textContent).toBe("1 running");
  });

  it("user click wins over auto-select once tasks resolves", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    // Click beta — URL pins it.
    const betaRow = await screen.findByTestId("agent-row-emploke/beta");
    act(() => {
      fireEvent.click(betaRow);
    });
    await waitFor(() => {
      const probe = screen.getByTestId("url-probe");
      expect(probe.getAttribute("data-search")).toContain("selected=emploke%2Fbeta");
    });
    // Tasks already resolved (mockResolvedValue([])); the user's pick
    // must not be replaced by the auto-select fallback.
    const pane = screen.getByTestId("agent-detail-pane");
    expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/beta");
  });

  it("row uses the shared AgentAvatar + AgentFqn primitives", () => {
    const agents = [makeAgent("langsensei/dev"), makeAgent("acme/dev")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    // Both rows render. Two different scopes share the same short name.
    const rowA = screen.getByTestId("agent-row-langsensei/dev");
    const rowB = screen.getByTestId("agent-row-acme/dev");

    // Each row renders the full FQN via the shared <AgentFqn> primitive.
    // We scope by the row so the assertion isn't confused by the same
    // primitive being mounted in the right-pane header for the selected
    // agent (v3 also adopted AgentFqn in the AgentDetailPane title).
    expect(rowA.querySelector('[data-testid="agent-fqn-langsensei/dev"]')).toBeTruthy();
    expect(rowB.querySelector('[data-testid="agent-fqn-acme/dev"]')).toBeTruthy();

    // And each row renders an avatar — colour-distinguishable because the
    // hash keys off the full FQN (see AgentAvatar lock-in tests).
    const avatarA = rowA.querySelector(
      '[data-testid="agent-avatar-langsensei/dev"]',
    ) as HTMLElement;
    const avatarB = rowB.querySelector('[data-testid="agent-avatar-acme/dev"]') as HTMLElement;
    expect(avatarA).toBeTruthy();
    expect(avatarB).toBeTruthy();
    expect(avatarA.style.backgroundColor).not.toBe(avatarB.style.backgroundColor);
  });

  it("selected row carries the agents-list__item--selected class hook (accent stripe)", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents?selected=emploke%2Fbeta",
    });

    const beta = await screen.findByTestId("agent-row-emploke/beta");
    expect(beta.className).toContain("agents-list__item--selected");
    const alpha = screen.getByTestId("agent-row-emploke/alpha");
    expect(alpha.className).not.toContain("agents-list__item--selected");
  });
});

describe("PR #189 polish v4 — auto-selected agent's sessions fetch fires (Bug 1)", () => {
  it("fires listSessions for the auto-selected agent when ?selected= is absent", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    mockListSessions.mockResolvedValue([] as SessionView[]);

    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    // The right pane drives off `effectiveSelectedFqn` (auto-select
    // fallback). Bug 1 in v3 was that `refreshSessions` keyed off the
    // raw URL `selectedFqn` instead, so `listSessions` never fired on
    // first paint without `?selected=` — and the pane sat on
    // "Loading…" forever. After the v4 re-key, the auto-selected agent
    // triggers the same listSessions call as an explicit URL pick.
    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });
    const lastCall = mockListSessions.mock.calls.at(-1) ?? [];
    expect(lastCall[0]?.agent).toBe("emploke/alpha");
  });

  it("re-fires listSessions when the user picks a different row (selection wins over auto-select)", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    mockListSessions.mockResolvedValue([] as SessionView[]);

    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });
    mockListSessions.mockClear();

    const betaRow = screen.getByTestId("agent-row-emploke/beta");
    act(() => {
      fireEvent.click(betaRow);
    });

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });
    const lastCall = mockListSessions.mock.calls.at(-1) ?? [];
    expect(lastCall[0]?.agent).toBe("emploke/beta");
  });
});

describe("PR #189 polish v7 — agent switch resets pane-local state (#193)", () => {
  it("clears the action-error banner when the user picks a different agent in the master list", async () => {
    // Repro for issue #193: after a failed dispatch from agent A leaves
    // the red `[data-testid="agent-detail-action-error"]` banner on the
    // pane, switching to agent B used to keep that banner mounted —
    // `AgentDetailPane` is rendered at the same JSX position by
    // `AgentsListPage` with only `fqn` swapping, so React reconciled
    // the same component instance and its `useState` slots carried
    // across. The v7 fix adds a `useEffect([fqn])` reset on the pane;
    // this test pins that behaviour.
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    mockListSessions.mockResolvedValue([] as SessionView[]);
    mockDispatchTask.mockRejectedValueOnce(new Error("dispatch failed (mock)"));

    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    // Auto-select picks alpha (first row). Wait for the pane to mount
    // against that agent before exercising the dispatch flow.
    const initialPane = await screen.findByTestId("agent-detail-pane");
    expect(initialPane.getAttribute("data-agent-fqn")).toBe("emploke/alpha");

    // Open the in-place DispatchModal on agent A.
    act(() => {
      fireEvent.click(screen.getByTestId("agent-detail-new-task"));
    });
    const briefInput = await waitFor(() => {
      const input = document.getElementById("task-brief") as HTMLInputElement | null;
      expect(input).toBeTruthy();
      return input as HTMLInputElement;
    });

    // Fill a valid brief and submit — the mocked dispatchTask rejects,
    // so AgentDetailPane catches the error and surfaces the action
    // banner on agent A's pane.
    await act(async () => {
      fireEvent.change(briefInput, { target: { value: "v7 repro brief" } });
    });
    const form = briefInput.closest("form") as HTMLFormElement;
    expect(form).toBeTruthy();
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByTestId("agent-detail-action-error")).toBeTruthy();
    });

    // Sanity: dispatchTask was actually invoked with agent A's fqn so
    // the banner we just observed is genuinely the failed-dispatch one.
    expect(mockDispatchTask).toHaveBeenCalledTimes(1);
    expect(mockDispatchTask.mock.calls[0]?.[0]).toBe("emploke/alpha");

    // Switch the master list to agent B.
    act(() => {
      fireEvent.click(screen.getByTestId("agent-row-emploke/beta"));
    });

    // The pane reconciles to agent B (same instance, new `fqn` prop).
    await waitFor(() => {
      expect(screen.getByTestId("agent-detail-pane").getAttribute("data-agent-fqn")).toBe(
        "emploke/beta",
      );
    });

    // The v7 fix: the `useEffect([fqn])` reset clears `actionError`
    // (and `busy` / `dispatchOpen` / `createOpen`) on agent switch, so
    // agent A's banner must NOT bleed into agent B's pane.
    expect(screen.queryByTestId("agent-detail-action-error")).toBeNull();
  });
});

describe("PR #189 polish v4 — running-first sort (Bug 5)", () => {
  it("orders active agents above idle, alpha within each bucket, on the default 'all' filter", async () => {
    // Three agents: A idle, B and C both active. The runningTasks
    // values are derived by computeAgentRuntimeViews from the tasks
    // list — give B 1 running task and C 2 running tasks (count must
    // NOT influence ordering — both go in the "active" bucket and
    // sort alphabetically within it).
    const agents = [
      makeAgent("emploke/aardvark"),
      makeAgent("emploke/beta"),
      makeAgent("emploke/charlie"),
    ];
    mockListTasks.mockResolvedValue([
      {
        id: "t-1",
        agent: "emploke/beta",
        status: "running",
        brief: "",
        details: "",
        origin: "cli",
        metadata: {},
        createdAt: "2026-05-23T00:00:00Z",
      } as unknown as TaskRecord,
      {
        id: "t-2",
        agent: "emploke/charlie",
        status: "running",
        brief: "",
        details: "",
        origin: "cli",
        metadata: {},
        createdAt: "2026-05-23T00:00:00Z",
      } as unknown as TaskRecord,
      {
        id: "t-3",
        agent: "emploke/charlie",
        status: "running",
        brief: "",
        details: "",
        origin: "cli",
        metadata: {},
        createdAt: "2026-05-23T00:00:00Z",
      } as unknown as TaskRecord,
    ]);

    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    // Wait for the rendered DOM order to settle after the tasks fetch
    // resolves — `computeAgentRuntimeViews` flips beta/charlie into
    // the "running" bucket then.
    await waitFor(() => {
      const activity = screen.getByTestId("agent-row-activity-emploke/beta");
      expect(activity.textContent).toMatch(/running/);
    });
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"][data-testid^="agent-row-"]'),
    ).map((el) => el.getAttribute("data-testid"));

    expect(rows).toEqual([
      "agent-row-emploke/beta",
      "agent-row-emploke/charlie",
      "agent-row-emploke/aardvark",
    ]);

    // Auto-select fallback picks the topmost active row (beta), NOT
    // the alphabetically-first row across all buckets (aardvark).
    const pane = screen.getByTestId("agent-detail-pane");
    expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/beta");
  });

  it("preserves alpha order when all agents are idle (regression for v4 Bug 5)", async () => {
    const agents = [
      makeAgent("emploke/zeta"),
      makeAgent("emploke/alpha"),
      makeAgent("emploke/middle"),
    ];
    mockListTasks.mockResolvedValue([]);

    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    await waitFor(() => {
      expect(screen.getByTestId("agent-row-emploke/alpha")).toBeTruthy();
    });
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"][data-testid^="agent-row-"]'),
    ).map((el) => el.getAttribute("data-testid"));
    expect(rows).toEqual([
      "agent-row-emploke/alpha",
      "agent-row-emploke/middle",
      "agent-row-emploke/zeta",
    ]);
  });
});

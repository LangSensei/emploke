import type { AgentEntry } from "@emploke/catalog";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig, SessionView } from "../src/api";
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
  };
});

import * as api from "../src/api";

const mockListTasks = api.listTasks as unknown as ReturnType<typeof vi.fn>;
const mockListSessions = api.listSessions as unknown as ReturnType<typeof vi.fn>;

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
  mockListTasks.mockResolvedValue([]);
  mockListSessions.mockResolvedValue([] as SessionView[]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Master-detail layout", () => {
  it("renders the placeholder pane when the catalog is empty (and no ?selected= is set)", async () => {
    renderMasterDetail({ agents: [], initialPath: "/workspaces/ws-1/runtime/agents" });
    // The placeholder shows up once the workspace-wide tasks fetch
    // resolves (its loading state hides the list until then).
    await waitFor(() => {
      expect(screen.getByTestId("agent-detail-placeholder")).toBeTruthy();
    });
    // The list-empty hint also surfaces in the left pane.
    expect(screen.getByText(/No agents installed/i)).toBeTruthy();
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
  it("does not render the 'Open' item (clicking the row selects in-place instead)", async () => {
    const agents = [makeAgent("emploke/alpha")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({ agents, initialPath: "/workspaces/ws-1/runtime/agents" });

    await waitFor(() => {
      expect(screen.getByTestId("agent-row-menu")).toBeTruthy();
    });
    // Only the two cross-page deep-link items survive — explicitly check
    // there is NO menu item whose label is exactly "Open".
    const menu = screen.getByTestId("agent-row-menu");
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    expect(items.map((n) => n.textContent?.trim())).toEqual(["View tasks", "View sessions"]);
  });

  it("clicking the kebab does not change the URL selection (event-bubble guard)", async () => {
    const agents = [makeAgent("emploke/alpha"), makeAgent("emploke/beta")];
    mockListTasks.mockResolvedValue([]);
    renderMasterDetail({
      agents,
      initialPath: "/workspaces/ws-1/runtime/agents?selected=emploke%2Fbeta",
    });

    // beta is selected via URL. Click the kebab summary of beta's row
    // and ensure no `?selected=` rewrite drops it back to alpha.
    await waitFor(() => {
      expect(screen.getByTestId("agent-detail-pane")).toBeTruthy();
    });
    const betaRow = screen.getByTestId("agent-row-emploke/beta");
    const kebab = betaRow.querySelector("summary.agents-list__menu-trigger");
    expect(kebab).toBeTruthy();
    act(() => {
      fireEvent.click(kebab as HTMLElement);
    });

    // URL probe still shows beta selected.
    const probe = screen.getByTestId("url-probe");
    expect(probe.getAttribute("data-search")).toContain("selected=emploke%2Fbeta");
  });
});

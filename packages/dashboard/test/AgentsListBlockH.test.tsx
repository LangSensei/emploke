import type { AgentEntry } from "@emploke/catalog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig, TaskRecord } from "../src/api";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { AgentsListPage } from "../src/pages/Runtime/AgentsListPage";

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listTasks: vi.fn(),
  };
});

import * as api from "../src/api";

const mockListTasks = api.listTasks as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
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
    brief: "",
    details: "",
    origin: "standalone",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
  } as unknown as TaskRecord;
}

function shell(agents: AgentEntry[]): WorkspaceShellContextValue {
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

function renderList(initialPath: string, agents: AgentEntry[]) {
  return render(
    <WorkspaceShellContext.Provider value={shell(agents)}>
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
  mockListTasks.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentsListPage Block H polish (§4.2)", () => {
  it("filter tabs hide agents that don't match (?filter=active|idle)", async () => {
    const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa"), makeAgent("emploke/docs")];
    // dev has 1 running task; qa & docs have only completed tasks → idle.
    mockListTasks.mockResolvedValue([
      makeTask("emploke/dev", "running", "t-r"),
      makeTask("emploke/qa", "succeeded", "t-s1"),
      makeTask("emploke/docs", "succeeded", "t-s2"),
    ]);

    renderList("/workspaces/ws-1/runtime/agents", agents);

    await waitFor(() => {
      // Three rows render initially under the "All" filter.
      expect(screen.getAllByText(/^dev$/).length).toBeGreaterThan(0);
    });
    // The "dev" name must always be visible across renders (it's both
    // running and idle-eligible only under "All" and "Active").
    expect(screen.queryAllByText(/^dev$/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/^qa$/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/^docs$/).length).toBeGreaterThan(0);

    // Switch to Active — only dev should remain.
    fireEvent.click(screen.getByTestId("agents-list-filter-active"));
    await waitFor(() => {
      expect(screen.queryAllByText(/^dev$/).length).toBeGreaterThan(0);
      expect(screen.queryAllByText(/^qa$/).length).toBe(0);
      expect(screen.queryAllByText(/^docs$/).length).toBe(0);
    });

    // Switch to Idle — dev disappears, qa+docs reappear.
    fireEvent.click(screen.getByTestId("agents-list-filter-idle"));
    await waitFor(() => {
      expect(screen.queryAllByText(/^dev$/).length).toBe(0);
      expect(screen.queryAllByText(/^qa$/).length).toBeGreaterThan(0);
      expect(screen.queryAllByText(/^docs$/).length).toBeGreaterThan(0);
    });
  });

  it("search filters rows by substring across short, scope, and fqn", async () => {
    const agents = [
      makeAgent("emploke/dev"),
      makeAgent("emploke/qa"),
      makeAgent("third-party/docs-writer"),
    ];
    mockListTasks.mockResolvedValue([]);

    renderList("/workspaces/ws-1/runtime/agents?q=docs", agents);

    await waitFor(() => {
      // Match on the short-name suffix "docs-writer".
      expect(screen.queryAllByText(/^docs-writer$/).length).toBeGreaterThan(0);
      // No match for dev or qa.
      expect(screen.queryAllByText(/^dev$/).length).toBe(0);
      expect(screen.queryAllByText(/^qa$/).length).toBe(0);
    });

    // Match against scope this time.
    const input = screen.getByTestId("agents-list-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "emploke" } });
    await waitFor(() => {
      expect(screen.queryAllByText(/^dev$/).length).toBeGreaterThan(0);
      expect(screen.queryAllByText(/^qa$/).length).toBeGreaterThan(0);
      expect(screen.queryAllByText(/^docs-writer$/).length).toBe(0);
    });
  });

  it("kebab menu 'View tasks' link href targets the global tasks page with ?agent=", async () => {
    const agents = [makeAgent("emploke/dev")];
    mockListTasks.mockResolvedValue([]);
    renderList("/workspaces/ws-1/runtime/agents", agents);

    await waitFor(() => {
      expect(screen.getByTestId("agent-row-menu-tasks")).toBeTruthy();
    });
    const tasksLink = screen.getByTestId("agent-row-menu-tasks") as HTMLAnchorElement;
    expect(tasksLink.getAttribute("href")).toBe("/workspaces/ws-1/runtime/tasks?agent=emploke/dev");
    const sessionsLink = screen.getByTestId("agent-row-menu-sessions") as HTMLAnchorElement;
    expect(sessionsLink.getAttribute("href")).toBe(
      "/workspaces/ws-1/runtime/sessions?agent=emploke/dev",
    );
  });
});

import type { AgentEntry } from "@emploke/catalog";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig, SessionView, TaskRecord } from "../src/api";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { AgentDetailPage } from "../src/pages/Runtime/AgentDetailPage";
import { avatarColorFor, avatarInitialsFor } from "../src/pages/Runtime/agentRuntime";

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

function makeTask(
  agent: string,
  status: TaskRecord["status"],
  id = `task-${Math.random()}`,
  endedAt?: string,
): TaskRecord {
  return {
    id,
    agent,
    status,
    brief: `${status} task`,
    details: "",
    origin: "standalone",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
    startedAt: "2026-05-23T00:00:00Z",
    ...(endedAt ? { endedAt } : {}),
  } as unknown as TaskRecord;
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "sess-1",
    agent: "emploke/dev",
    runtime: "copilot",
    runtimeSessionId: null,
    lastActiveAt: null,
    createdAt: "2026-05-23T00:00:00Z",
    workdir: "/tmp/w",
    lastLaunchMode: null,
    ...overrides,
  } as unknown as SessionView;
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

function renderDetail(initialPath: string, agents: AgentEntry[]) {
  return render(
    <WorkspaceShellContext.Provider value={shell(agents)}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/workspaces/:wsId/runtime/agents/:scope/:short/overview"
            element={<AgentDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </WorkspaceShellContext.Provider>,
  );
}

beforeEach(() => {
  mockListTasks.mockReset();
  mockListSessions.mockReset();
  mockListTasks.mockResolvedValue([]);
  mockListSessions.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agent detail header — Phase 1.5 Block I (§4.3)", () => {
  const agents = [makeAgent("emploke/dev")];

  it("renders an avatar circle with deterministic color + 2-letter initials", async () => {
    mockListTasks.mockResolvedValue([makeTask("emploke/dev", "succeeded", "t-1")]);
    mockListSessions.mockResolvedValue([makeSession({ id: "s-1" })]);

    renderDetail("/workspaces/ws-1/runtime/agents/emploke/dev/overview", agents);

    const avatar = await screen.findByTestId("agent-detail-avatar");
    expect(avatar.textContent).toBe(avatarInitialsFor("dev"));
    // The colour helper picks deterministically from the existing
    // accent palette — same fqn yields the same value across renders.
    const expected = avatarColorFor("emploke/dev");
    expect((avatar as HTMLElement).style.backgroundColor).toBe(expected);
  });

  it("renders exactly 3 KPI tiles with the labels Running tasks / Total tasks (7d) / Sessions (7d)", async () => {
    mockListTasks.mockResolvedValue([
      makeTask("emploke/dev", "running", "t-r"),
      makeTask("emploke/dev", "succeeded", "t-s"),
    ]);
    mockListSessions.mockResolvedValue([makeSession({ id: "s-1" }), makeSession({ id: "s-2" })]);

    renderDetail("/workspaces/ws-1/runtime/agents/emploke/dev/overview", agents);

    const kpis = await screen.findByTestId("agent-detail-kpis");
    const labels = Array.from(kpis.querySelectorAll(".kpi-tile__label")).map((n) => n.textContent);
    expect(labels).toEqual(["Running tasks", "Total tasks (7d)", "Sessions (7d)"]);
    const values = Array.from(kpis.querySelectorAll(".kpi-tile__value")).map((n) => n.textContent);
    expect(values).toEqual(["1", "2", "2"]);
  });

  it("+ New task button links to /runtime/tasks?agent=<fqn>&dispatch=1", async () => {
    mockListTasks.mockResolvedValue([]);
    mockListSessions.mockResolvedValue([]);

    renderDetail("/workspaces/ws-1/runtime/agents/emploke/dev/overview", agents);

    const newTaskLink = await screen.findByTestId("agent-detail-new-task");
    expect(newTaskLink.getAttribute("href")).toBe(
      "/workspaces/ws-1/runtime/tasks?agent=emploke/dev&dispatch=1",
    );
    // Configure button targets the catalog tab with the agent fqn hint.
    const configureLink = screen.getByTestId("agent-detail-configure");
    expect(configureLink.getAttribute("href")).toBe(
      "/workspaces/ws-1/catalog/agents?agent=emploke/dev",
    );
  });
});

describe("Agent Overview 2x2 grid — Phase 1.5 Block J (§4.4)", () => {
  const agents = [makeAgent("emploke/dev")];

  it("renders the 2x2 grid with Recent tasks / Active sessions / Current activity cells", async () => {
    mockListTasks.mockResolvedValue([
      makeTask("emploke/dev", "running", "t-r"),
      makeTask("emploke/dev", "succeeded", "t-s"),
    ]);
    mockListSessions.mockResolvedValue([makeSession({ id: "s-1" })]);

    renderDetail("/workspaces/ws-1/runtime/agents/emploke/dev/overview", agents);

    const grid = await screen.findByTestId("agent-overview-grid");
    expect(grid).toBeTruthy();
    // Three cells — Capabilities is omitted (no data pipe, §4.4); the
    // "Current activity" cell spans the bottom row.
    expect(screen.getByTestId("agent-overview-cell-tasks")).toBeTruthy();
    expect(screen.getByTestId("agent-overview-cell-sessions")).toBeTruthy();
    expect(screen.getByTestId("agent-overview-cell-activity")).toBeTruthy();
  });

  it("Current activity cell shows 'Idle since X' when no running task is present", async () => {
    mockListTasks.mockResolvedValue([
      makeTask("emploke/dev", "succeeded", "t-1", "2026-05-22T10:00:00Z"),
    ]);
    mockListSessions.mockResolvedValue([makeSession({ id: "s-1" })]);

    renderDetail("/workspaces/ws-1/runtime/agents/emploke/dev/overview", agents);

    const idle = await screen.findByTestId("agent-overview-idle");
    expect(idle.textContent).toMatch(/^Idle/);
    expect(idle.textContent).toMatch(/since/);
  });
});

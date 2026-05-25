import type { AgentEntry } from "@emploke/catalog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, TaskRecord } from "../src/api";
import { avatarColorForFqn, monogramForLabel } from "../src/components/agents/AgentAvatar";
import { AgentDetailPane } from "../src/pages/Runtime/AgentDetailPane";

// PR #189 polish v2: the per-agent header (avatar, name, KPI tiles,
// action buttons) was extracted into the pure-presentational
// `AgentDetailPane`. These tests now mount the pane directly with
// synthesised props instead of routing through the legacy
// `AgentDetailPage` standalone URL (which is now a redirect shim into
// the master Agents page).
//
// PR #189 polish v3: the avatar is now rendered via the shared
// <AgentAvatar> primitive (the deterministic-colour hash keys off the
// FULL fqn), and the "+ New task" button mounts <DispatchModal> in
// place instead of navigating to /runtime/tasks?dispatch=1.

// The AgentDetailPane fetches runtimes on mount + dispatches tasks
// directly. Mock both endpoints so the tests don't reach the network.
vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listRuntimes: vi.fn(),
    dispatchTask: vi.fn(),
    createSession: vi.fn(),
  };
});

import * as api from "../src/api";
import { WorkspaceShellContext } from "../src/components/WorkspaceShellContext";

const mockListRuntimes = api.listRuntimes as unknown as ReturnType<typeof vi.fn>;

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

interface RenderPaneOptions {
  fqn?: string;
  entry?: AgentEntry | null;
  tasks?: TaskRecord[] | null;
  sessions?: SessionView[] | null;
  wsId?: string;
  /** Additional agents to seed the WorkspaceShell with (defaults to just `entry`). */
  extraAgents?: AgentEntry[];
}

function renderPane(opts: RenderPaneOptions = {}) {
  const fqn = opts.fqn ?? "emploke/dev";
  const entry = opts.entry === undefined ? makeAgent(fqn) : opts.entry;
  const agents: AgentEntry[] = entry
    ? [entry, ...(opts.extraAgents ?? [])]
    : (opts.extraAgents ?? []);
  return render(
    <WorkspaceShellContext.Provider value={shellValue(agents, opts.wsId ?? "ws-1")}>
      <MemoryRouter>
        <AgentDetailPane
          fqn={fqn}
          entry={entry}
          wsId={opts.wsId ?? "ws-1"}
          tasks={opts.tasks ?? []}
          sessions={opts.sessions ?? []}
          tasksError={null}
          sessionsError={null}
        />
      </MemoryRouter>
    </WorkspaceShellContext.Provider>,
  );
}

function shellValue(
  agents: AgentEntry[],
  wsId: string,
): import("../src/components/WorkspaceShellContext").WorkspaceShellContextValue {
  const data = {
    overview: null,
    skills: [],
    agents,
    mcps: [],
  } as unknown as import("../src/api").CatalogData;
  return {
    wsId,
    workspaces: [],
    data,
    config: { pathSeparator: "/" } as unknown as import("../src/api").ServerConfig,
    refreshData: async () => {},
  };
}

beforeEach(() => {
  // Tests don't hit the API directly any more (the pane is pure), but
  // a freshly-stubbed vi env keeps any future addition isolated.
  mockListRuntimes.mockReset();
  mockListRuntimes.mockResolvedValue([{ kind: "copilot" }, { kind: "claude" }]);
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agent detail header — Phase 1.5 Block I (§4.3) + v3 avatar refactor", () => {
  it("renders an avatar via the shared <AgentAvatar> primitive (deterministic colour + monogram)", async () => {
    renderPane({
      tasks: [makeTask("emploke/dev", "succeeded", "t-1")],
      sessions: [makeSession({ id: "s-1" })],
    });

    // v3: the avatar lives at `agent-avatar-<fqn>` (no more `agent-detail-avatar`).
    const avatar = await screen.findByTestId("agent-avatar-emploke/dev");
    expect(avatar.textContent).toBe(monogramForLabel("dev"));
    const expected = avatarColorForFqn("emploke/dev");
    expect((avatar as HTMLElement).style.backgroundColor.toLowerCase()).toBe(
      expected.toLowerCase(),
    );
  });

  it("renders exactly 3 KPI tiles with the labels Running tasks / Total tasks (7d) / Sessions (7d)", async () => {
    renderPane({
      tasks: [
        makeTask("emploke/dev", "running", "t-r"),
        makeTask("emploke/dev", "succeeded", "t-s"),
      ],
      sessions: [makeSession({ id: "s-1" }), makeSession({ id: "s-2" })],
    });

    const kpis = await screen.findByTestId("agent-detail-kpis");
    const labels = Array.from(kpis.querySelectorAll(".kpi-tile__label")).map((n) => n.textContent);
    expect(labels).toEqual(["Running tasks", "Total tasks (7d)", "Sessions (7d)"]);
    const values = Array.from(kpis.querySelectorAll(".kpi-tile__value")).map((n) => n.textContent);
    expect(values).toEqual(["1", "2", "2"]);
  });

  it("'+ New task' is a button that opens DispatchModal in place (no nav)", async () => {
    renderPane({ tasks: [], sessions: [] });

    // It is a <button>, not a <Link> — no href attribute.
    const newTaskBtn = await screen.findByTestId("agent-detail-new-task");
    expect(newTaskBtn.tagName).toBe("BUTTON");
    expect(newTaskBtn.getAttribute("href")).toBeNull();

    // Clicking it opens the DispatchModal seeded with the current fqn.
    fireEvent.click(newTaskBtn);
    await waitFor(() => {
      const dropdown = document.getElementById("task-agent") as HTMLSelectElement | null;
      expect(dropdown).toBeTruthy();
      expect(dropdown!.value).toBe("emploke/dev");
    });
  });

  it("'+ New session' is a button that opens CreateModal in place seeded with the current agent", async () => {
    renderPane({ tasks: [], sessions: [] });

    const newSessionBtn = await screen.findByTestId("agent-detail-new-session");
    expect(newSessionBtn.tagName).toBe("BUTTON");
    expect(newSessionBtn.getAttribute("href")).toBeNull();

    fireEvent.click(newSessionBtn);
    await waitFor(() => {
      const dropdown = document.getElementById("new-session-agent") as HTMLSelectElement | null;
      expect(dropdown).toBeTruthy();
      expect(dropdown!.value).toBe("emploke/dev");
    });
  });

  it("Configure stays a <Link> targeting the catalog tab with the agent fqn hint", async () => {
    renderPane({ tasks: [], sessions: [] });
    const configureLink = await screen.findByTestId("agent-detail-configure");
    expect(configureLink.tagName).toBe("A");
    expect(configureLink.getAttribute("href")).toBe(
      "/workspaces/ws-1/catalog/agents?agent=emploke/dev",
    );
  });
});

describe("Agent Overview 2x2 grid — Phase 1.5 Block J (§4.4)", () => {
  it("renders the 2x2 grid with Recent tasks / Active sessions / Current activity cells", async () => {
    renderPane({
      tasks: [
        makeTask("emploke/dev", "running", "t-r"),
        makeTask("emploke/dev", "succeeded", "t-s"),
      ],
      sessions: [makeSession({ id: "s-1" })],
    });

    const grid = await screen.findByTestId("agent-overview-grid");
    expect(grid).toBeTruthy();
    // Three cells — Capabilities is omitted (no data pipe, §4.4); the
    // "Current activity" cell spans the bottom row.
    expect(screen.getByTestId("agent-overview-cell-tasks")).toBeTruthy();
    expect(screen.getByTestId("agent-overview-cell-sessions")).toBeTruthy();
    expect(screen.getByTestId("agent-overview-cell-activity")).toBeTruthy();
  });

  it("Current activity cell shows 'Idle since X' when no running task is present", async () => {
    renderPane({
      tasks: [makeTask("emploke/dev", "succeeded", "t-1", "2026-05-22T10:00:00Z")],
      sessions: [makeSession({ id: "s-1" })],
    });

    const idle = await screen.findByTestId("agent-overview-idle");
    expect(idle.textContent).toMatch(/^Idle/);
    expect(idle.textContent).toMatch(/since/);
  });
});

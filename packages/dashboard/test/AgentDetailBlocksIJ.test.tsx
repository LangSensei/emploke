import type { AgentEntry } from "@emploke/catalog";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, TaskRecord } from "../src/api";
import { AgentDetailPane } from "../src/pages/Runtime/AgentDetailPane";
import { avatarColorFor, avatarInitialsFor } from "../src/pages/Runtime/agentRuntime";

// PR #189 polish v2: the per-agent header (avatar, name, KPI tiles,
// action buttons) was extracted into the pure-presentational
// `AgentDetailPane`. These tests now mount the pane directly with
// synthesised props instead of routing through the legacy
// `AgentDetailPage` standalone URL (which is now a redirect shim into
// the master Agents page).

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
}

function renderPane(opts: RenderPaneOptions = {}) {
  const fqn = opts.fqn ?? "emploke/dev";
  const entry = opts.entry === undefined ? makeAgent(fqn) : opts.entry;
  return render(
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
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Tests don't hit the API directly any more (the pane is pure), but
  // a freshly-stubbed vi env keeps any future addition isolated.
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Agent detail header — Phase 1.5 Block I (§4.3)", () => {
  it("renders an avatar circle with deterministic color + 2-letter initials", async () => {
    renderPane({
      tasks: [makeTask("emploke/dev", "succeeded", "t-1")],
      sessions: [makeSession({ id: "s-1" })],
    });

    const avatar = await screen.findByTestId("agent-detail-avatar");
    expect(avatar.textContent).toBe(avatarInitialsFor("dev"));
    // The colour helper picks deterministically from the existing
    // accent palette — same fqn yields the same value across renders.
    const expected = avatarColorFor("emploke/dev");
    expect((avatar as HTMLElement).style.backgroundColor).toBe(expected);
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

  it("+ New task button links to /runtime/tasks?agent=<fqn>&dispatch=1", async () => {
    renderPane({ tasks: [], sessions: [] });

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

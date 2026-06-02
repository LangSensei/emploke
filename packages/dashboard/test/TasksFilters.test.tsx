import type { AgentEntry } from "@emploke/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig, TaskRecord } from "../src/api";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { TasksPage } from "../src/pages/Tasks";

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listTasks: vi.fn(),
    listRuntimes: vi.fn(),
    getTask: vi.fn(),
    fetchTaskActivity: vi.fn(),
  };
});

import * as api from "../src/api";

const mockListTasks = api.listTasks as unknown as ReturnType<typeof vi.fn>;
const mockListRuntimes = api.listRuntimes as unknown as ReturnType<typeof vi.fn>;
const mockGetTask = api.getTask as unknown as ReturnType<typeof vi.fn>;
const mockFetchTaskActivity = api.fetchTaskActivity as unknown as ReturnType<typeof vi.fn>;

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
    brief: `${status} task for ${agent}`,
    details: "",
    origin: "standalone",
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

function renderTasks(initialPath: string, agents: AgentEntry[]) {
  const value = makeShellValue(agents);
  return render(
    <WorkspaceShellContext.Provider value={value}>
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
    </WorkspaceShellContext.Provider>,
  );
}

beforeEach(() => {
  mockListTasks.mockReset();
  mockListRuntimes.mockReset();
  mockGetTask.mockReset();
  mockFetchTaskActivity.mockReset();
  mockListTasks.mockResolvedValue([]);
  mockListRuntimes.mockResolvedValue([]);
  mockGetTask.mockResolvedValue(makeTask("emploke/dev", "succeeded", "task-x"));
  mockFetchTaskActivity.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TasksPage URL-driven filters (Phase 1.5 §4.6, Block G)", () => {
  it("reads ?agent= from URL and pre-applies the server-side narrow on mount", async () => {
    const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa")];
    mockListTasks.mockResolvedValue([]);

    const { container } = renderTasks("/workspaces/ws-1/runtime/tasks?agent=emploke/dev", agents);

    await waitFor(() => {
      expect(mockListTasks).toHaveBeenCalled();
    });
    const lastCall = mockListTasks.mock.calls.at(-1) ?? [];
    expect(lastCall[0]?.agent).toBe("emploke/dev");

    const select = container.querySelector("#task-agent-filter") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("emploke/dev");
  });

  it("reads ?taskId= and selects the matching row in the master-detail pane", async () => {
    const agents = [makeAgent("emploke/dev")];
    const tasks = [
      makeTask("emploke/dev", "running", "task-A"),
      makeTask("emploke/dev", "succeeded", "task-B"),
      makeTask("emploke/dev", "succeeded", "task-C"),
    ];
    mockListTasks.mockResolvedValue(tasks);
    mockGetTask.mockResolvedValue(tasks[1]);

    renderTasks("/workspaces/ws-1/runtime/tasks?taskId=task-B", agents);

    // Detail pane fetch is keyed off the selected id derived from the URL.
    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledWith("task-B");
    });
  });
});

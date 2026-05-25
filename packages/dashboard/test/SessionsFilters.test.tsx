import type { AgentEntry } from "@emploke/catalog";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig } from "../src/api";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { SessionsPage } from "../src/pages/Sessions";

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listSessions: vi.fn(),
    listRuntimes: vi.fn(),
  };
});

import * as api from "../src/api";

const mockListSessions = api.listSessions as unknown as ReturnType<typeof vi.fn>;
const mockListRuntimes = api.listRuntimes as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version: "1.0.0" },
    status: "ready",
  } as unknown as AgentEntry;
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

function renderSessions(initialPath: string, agents: AgentEntry[] = []) {
  const value = makeShellValue(agents);
  return render(
    <WorkspaceShellContext.Provider value={value}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/workspaces/:wsId/runtime/sessions"
            element={
              <SessionsPage
                agents={agents}
                config={value.config}
                currentWorkspaceId={value.wsId}
                workspaces={[]}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </WorkspaceShellContext.Provider>,
  );
}

beforeEach(() => {
  mockListSessions.mockReset();
  mockListRuntimes.mockReset();
  mockListSessions.mockResolvedValue([]);
  mockListRuntimes.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionsPage URL-driven filters (Phase 1.5 §4.5, Block G)", () => {
  it("reads ?agent= from URL and pre-applies the filter on mount", async () => {
    const agents = [makeAgent("emploke/dev"), makeAgent("emploke/qa")];
    mockListSessions.mockResolvedValue([]);

    const { container } = renderSessions(
      "/workspaces/ws-1/runtime/sessions?agent=emploke/dev",
      agents,
    );

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });
    // The agent <select> on the page toolbar reflects the URL value.
    const select = container.querySelector("#agent-filter") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("emploke/dev");
    // And the server-side filter narrowing was applied — the page's
    // primary effect translates the URL value into the `listSessions`
    // call's `agent` option.
    const lastCall = mockListSessions.mock.calls.at(-1) ?? [];
    expect(lastCall[0]?.agent).toBe("emploke/dev");
  });
});

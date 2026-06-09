import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHeaderWire } from "../../src/api";

vi.mock("../../src/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/api")>("../../src/api");
  return {
    ...actual,
    listWorkflows: vi.fn(),
  };
});

import * as api from "../../src/api";
import { ALL_AGENTS } from "../../src/components/tasks/shared";
import { useWorkflows } from "../../src/hooks/useWorkflows";

const mockList = api.listWorkflows as unknown as ReturnType<typeof vi.fn>;

function makeWf(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-1",
    brief: "Test",
    status: "succeeded",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockList.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWorkflows — historicalAgentNames snapshot", () => {
  it("snapshots agents from the initial agent-unfiltered fetch", async () => {
    mockList.mockResolvedValue([
      makeWf({ id: "wf-a", coordinatorAgent: "emploke/dev" }),
      makeWf({ id: "wf-b", coordinatorAgent: "emploke/review" }),
    ]);
    const { result } = renderHook(() =>
      useWorkflows({
        currentWorkspaceId: "ws-1",
        idQuery: "",
        agentFilter: ALL_AGENTS,
        timeFilter: "7d",
      }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect([...result.current.historicalAgentNames].sort()).toEqual([
      "emploke/dev",
      "emploke/review",
    ]);
  });

  it("retains the historical set when a subsequent fetch narrows by agent", async () => {
    // First fetch: agent-unfiltered, returns two agents → snapshot grows.
    // Second fetch: narrowed to one agent → snapshot must NOT shrink so
    // the dropdown still surfaces the other agent. This is the core
    // user-flow the F5 reviewer item calls out: switching from agent A
    // to agent B in one click even when A's filter is currently active.
    mockList.mockResolvedValueOnce([
      makeWf({ id: "wf-a", coordinatorAgent: "emploke/dev" }),
      makeWf({ id: "wf-b", coordinatorAgent: "emploke/review" }),
    ]);
    const { result, rerender } = renderHook(
      ({ agentFilter }: { agentFilter: string }) =>
        useWorkflows({
          currentWorkspaceId: "ws-1",
          idQuery: "",
          agentFilter,
          timeFilter: "7d",
        }),
      { initialProps: { agentFilter: ALL_AGENTS } },
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect([...result.current.historicalAgentNames].sort()).toEqual([
      "emploke/dev",
      "emploke/review",
    ]);

    // Narrow to agent-dev: server returns only dev rows.
    mockList.mockResolvedValueOnce([makeWf({ id: "wf-a", coordinatorAgent: "emploke/dev" })]);
    rerender({ agentFilter: "emploke/dev" });
    await waitFor(() => expect(result.current.workflows).toHaveLength(1));

    // Historical set must still include review — the snapshot is
    // frozen while a narrow agent filter is active.
    expect([...result.current.historicalAgentNames].sort()).toEqual([
      "emploke/dev",
      "emploke/review",
    ]);
  });

  it("grows the snapshot when a later unfiltered fetch surfaces a new agent", async () => {
    mockList.mockResolvedValueOnce([makeWf({ id: "wf-a", coordinatorAgent: "emploke/dev" })]);
    const { result } = renderHook(() =>
      useWorkflows({
        currentWorkspaceId: "ws-1",
        idQuery: "",
        agentFilter: ALL_AGENTS,
        timeFilter: "7d",
      }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect([...result.current.historicalAgentNames]).toEqual(["emploke/dev"]);

    // A polling-style refresh that surfaces a newly-introduced agent
    // should grow the snapshot (no full reload required).
    mockList.mockResolvedValueOnce([
      makeWf({ id: "wf-a", coordinatorAgent: "emploke/dev" }),
      makeWf({ id: "wf-c", coordinatorAgent: "emploke/triage" }),
    ]);
    await act(async () => {
      await result.current.refresh();
    });
    expect([...result.current.historicalAgentNames].sort()).toEqual([
      "emploke/dev",
      "emploke/triage",
    ]);
  });
});

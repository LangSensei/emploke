import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowArtifactsResponse } from "../../src/api";

vi.mock("../../src/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/api")>("../../src/api");
  return {
    ...actual,
    listWorkflowArtifacts: vi.fn(),
  };
});

import * as api from "../../src/api";
import { useWorkflowArtifacts } from "../../src/hooks/useWorkflowArtifacts";

const mockList = api.listWorkflowArtifacts as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockList.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const emptyResp: WorkflowArtifactsResponse = { artifacts: [] };

describe("useWorkflowArtifacts", () => {
  it("returns an empty snapshot and never fetches when workflowId is null", async () => {
    const { result } = renderHook(() => useWorkflowArtifacts(null, false));
    expect(result.current.artifacts).toBeNull();
    expect(result.current.loaded).toBe(false);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("fetches once on mount and sets `loaded` + `artifacts`", async () => {
    mockList.mockResolvedValue({
      artifacts: [
        {
          kind: "workflow-summary",
          path: "x.md",
          size: 1,
          modifiedAt: "2026-05-28T00:00:00.000Z",
          mimeBucket: "text",
        },
      ],
    } satisfies WorkflowArtifactsResponse);
    const { result } = renderHook(() => useWorkflowArtifacts("wf-1", false));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith("wf-1");
    expect(result.current.artifacts?.artifacts).toHaveLength(1);
  });

  it("polls every WORKFLOW_POLL_INTERVAL_MS while isRunning is true", async () => {
    mockList.mockResolvedValue(emptyResp);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useWorkflowArtifacts("wf-1", true));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(2100);
      await Promise.resolve();
    });
    expect(mockList.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not poll when isRunning is false (terminal workflow)", async () => {
    mockList.mockResolvedValue(emptyResp);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useWorkflowArtifacts("wf-1", false));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("guards stale responses via the monotonic seq counter", async () => {
    let resolveFirst: (v: WorkflowArtifactsResponse) => void = () => {};
    const firstPromise = new Promise<WorkflowArtifactsResponse>((res) => {
      resolveFirst = res;
    });
    mockList.mockImplementationOnce(() => firstPromise);
    mockList.mockResolvedValueOnce({
      artifacts: [
        {
          kind: "workflow-summary",
          path: "fresh.md",
          size: 2,
          modifiedAt: "2026-05-28T00:00:00.000Z",
          mimeBucket: "text",
        },
      ],
    });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useWorkflowArtifacts(id, false),
      { initialProps: { id: "wf-1" } },
    );
    // Trigger the workflow swap → second fetch is in flight + completes
    // before we resolve the first.
    rerender({ id: "wf-2" });
    await waitFor(() => expect(result.current.artifacts?.artifacts?.[0]?.path).toBe("fresh.md"));

    // Now resolve the original (stale) fetch — `seq` is no longer
    // equal to the request's, so the result must be ignored.
    resolveFirst({
      artifacts: [
        {
          kind: "workflow-summary",
          path: "stale.md",
          size: 9,
          modifiedAt: "2026-05-28T00:00:00.000Z",
          mimeBucket: "text",
        },
      ],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.artifacts?.artifacts?.[0]?.path).toBe("fresh.md");
  });
});

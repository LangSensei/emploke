import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskActivity, TaskRecord } from "../src/api";

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    getTask: vi.fn(),
    fetchTaskActivity: vi.fn(),
    subscribeTaskActivity: vi.fn(() => ({ close: () => {} })),
  };
});

import * as api from "../src/api";
import { useTaskDetail } from "../src/hooks/useTaskDetail";

const mockGetTask = api.getTask as unknown as ReturnType<typeof vi.fn>;
const mockFetchTaskActivity = api.fetchTaskActivity as unknown as ReturnType<typeof vi.fn>;

function makeTask(id: string, status: TaskRecord["status"] = "succeeded"): TaskRecord {
  return {
    id,
    agent: "demo-agent",
    brief: `brief for ${id}`,
    origin: "cli",
    status,
    metadata: {},
    createdAt: "2026-05-28T00:00:00Z",
    startedAt: "2026-05-28T00:00:01Z",
    endedAt: status === "succeeded" ? "2026-05-28T00:01:00Z" : undefined,
  } as unknown as TaskRecord;
}

function emptyActivity(): TaskActivity {
  return { activity: [], result: null, totalItems: 0 };
}

/**
 * Host component that drives the hook from outside React and exposes
 * the current `task.id` so tests can assert which task's response was
 * committed. The "switch" button bumps the requested task id.
 */
function Host({ initialId, nextId }: { initialId: string; nextId: string }) {
  const [taskId, setTaskId] = useState(initialId);
  const { task } = useTaskDetail(taskId, 99999);
  return (
    <div>
      <span data-testid="visible-id">{task?.id ?? "none"}</span>
      <button type="button" data-testid="switch-btn" onClick={() => setTaskId(nextId)}>
        switch
      </button>
    </div>
  );
}

beforeEach(() => {
  mockGetTask.mockReset();
  mockFetchTaskActivity.mockReset();
  mockFetchTaskActivity.mockResolvedValue(emptyActivity());
});

afterEach(() => cleanup());

describe("useTaskDetail rapid-task-switch race", () => {
  /**
   * Regression test for the rapid-prev/next race fixed in PR #234
   * follow-up: a slow getTask() response from a previous task swap
   * MUST NOT overwrite the current task's state. Previously the
   * `inFlightRef` early-return blocked the new fetch while the stale
   * response still passed the token check.
   */
  it("drops the stale response when the user switches tasks mid-flight", async () => {
    // Hold the first response so we can resolve it AFTER the switch.
    let resolveTaskA: (t: TaskRecord) => void = () => {};
    const taskAPromise = new Promise<TaskRecord>((resolve) => {
      resolveTaskA = resolve;
    });

    // Resolve task B immediately; resolve task A only when triggered.
    mockGetTask.mockImplementation((id: string) => {
      if (id === "task-a") return taskAPromise;
      if (id === "task-b") return Promise.resolve(makeTask("task-b"));
      throw new Error(`unexpected getTask id: ${id}`);
    });

    render(<Host initialId="task-a" nextId="task-b" />);

    // Initially no task is committed (task-a is still in flight).
    expect(screen.getByTestId("visible-id").textContent).toBe("none");

    // Switch to task-b while task-a is still pending.
    await act(async () => {
      screen.getByTestId("switch-btn").click();
    });

    // task-b's fetch must complete and commit.
    await waitFor(() => {
      expect(screen.getByTestId("visible-id").textContent).toBe("task-b");
    });

    // Now resolve the stale task-a response — it must NOT overwrite
    // task-b's state.
    await act(async () => {
      resolveTaskA(makeTask("task-a"));
      // Flush microtasks so the .then() handler runs.
      await Promise.resolve();
      await Promise.resolve();
    });

    // task-b stays visible — stale response was dropped.
    expect(screen.getByTestId("visible-id").textContent).toBe("task-b");
  });

  it("commits the latest fetch when both responses arrive after the switch", async () => {
    let resolveTaskA: (t: TaskRecord) => void = () => {};
    let resolveTaskB: (t: TaskRecord) => void = () => {};
    const taskAPromise = new Promise<TaskRecord>((r) => {
      resolveTaskA = r;
    });
    const taskBPromise = new Promise<TaskRecord>((r) => {
      resolveTaskB = r;
    });

    mockGetTask.mockImplementation((id: string) => {
      if (id === "task-a") return taskAPromise;
      if (id === "task-b") return taskBPromise;
      throw new Error(`unexpected getTask id: ${id}`);
    });

    render(<Host initialId="task-a" nextId="task-b" />);
    expect(screen.getByTestId("visible-id").textContent).toBe("none");

    // Switch before either response arrives.
    await act(async () => {
      screen.getByTestId("switch-btn").click();
    });

    // task-a's response arrives FIRST (after the switch). Must be
    // dropped because we're no longer interested in it.
    await act(async () => {
      resolveTaskA(makeTask("task-a"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("visible-id").textContent).toBe("none");

    // task-b's response arrives — it should commit.
    await act(async () => {
      resolveTaskB(makeTask("task-b"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("visible-id").textContent).toBe("task-b");
    });
  });
});

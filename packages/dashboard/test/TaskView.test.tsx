import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../src/api";
import { TaskView } from "../src/components/task-view";

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-abc",
    agent: "demo-agent",
    brief: "Do the thing",
    details: "Detailed instructions for the thing.",
    origin: "cli",
    status: "succeeded",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
    startedAt: "2026-05-23T00:00:00Z",
    endedAt: "2026-05-23T00:01:00Z",
    success: { output: "All done." },
    ...overrides,
  } as unknown as TaskRecord;
}

afterEach(() => cleanup());

describe("TaskView (dumb shared task-detail view)", () => {
  it("renders requestedTaskId as the header title fallback when task is still loading", () => {
    render(
      <TaskView
        task={null}
        requestedTaskId="task-loading-id"
        activity={null}
        activityError={null}
        onLoadOlder={vi.fn(() => Promise.resolve())}
      />,
    );
    // Title falls back to requestedTaskId.
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("task-loading-id");
    // Body shows the loading placeholder, not a tab.
    expect(screen.getByText(/Loading task/)).toBeTruthy();
    // No meta-chip / statbar rendered while task is null.
    expect(document.querySelector(".task-detail__meta-row")).toBeNull();
    expect(document.querySelector(".task-detail__statbar")).toBeNull();
  });

  it("renders title from task.brief, status badge, agent chip, and statbar once task is loaded", () => {
    const task = makeTask({ brief: "Refactor schedules", agent: "schedule-agent" });
    render(
      <TaskView
        task={task}
        requestedTaskId="task-abc"
        activity={null}
        activityError={null}
        onLoadOlder={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Refactor schedules");
    expect(screen.getByText("schedule-agent")).toBeTruthy();
    // Task-id code element renders inside the statbar.
    expect(screen.getByText("task-abc").tagName.toLowerCase()).toBe("code");
  });

  it("switches between Overview / Activity / Artifacts tabs", () => {
    const task = makeTask({ status: "succeeded", success: { output: "Job done." } });
    render(
      <TaskView
        task={task}
        requestedTaskId="task-abc"
        activity={null}
        activityError={null}
        onLoadOlder={vi.fn(() => Promise.resolve())}
      />,
    );
    // Overview is the default — Summary card visible.
    expect(screen.getByText("Summary")).toBeTruthy();

    // Switch to Activity.
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    // Activity tab body replaces overview.
    expect(screen.queryByText("Summary")).toBeNull();

    // Switch to Artifacts.
    fireEvent.click(screen.getByRole("button", { name: /Artifacts \(\d+\)/ }));
    expect(screen.queryByText("Summary")).toBeNull();
  });

  it("collapses the title back to clamp mode when requestedTaskId changes", () => {
    const taskA = makeTask({ id: "task-A", brief: "A long brief that the user expanded" });
    const { rerender } = render(
      <TaskView
        task={taskA}
        requestedTaskId="task-A"
        activity={null}
        activityError={null}
        onLoadOlder={vi.fn(() => Promise.resolve())}
      />,
    );
    // Expand the title.
    const titleBtn = screen.getByRole("button", { name: "Expand title" });
    fireEvent.click(titleBtn);
    expect(screen.getByRole("button", { name: "Collapse title" })).toBeTruthy();

    // Swap to a different requested task id — title should re-clamp.
    const taskB = makeTask({ id: "task-B", brief: "Second task" });
    rerender(
      <TaskView
        task={taskB}
        requestedTaskId="task-B"
        activity={null}
        activityError={null}
        onLoadOlder={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(screen.getByRole("button", { name: "Expand title" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse title" })).toBeNull();
  });
});

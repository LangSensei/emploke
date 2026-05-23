import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../src/api";
import { OverviewTab } from "../src/components/tasks/TaskDetail/OverviewTab";

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-abc",
    agent: "ag",
    brief: "b",
    details: "the original brief details",
    origin: "cli",
    status: "succeeded",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
    startedAt: "2026-05-23T00:00:00Z",
    ...overrides,
  } as unknown as TaskRecord;
}

afterEach(() => cleanup());

describe("OverviewTab (iter-2 B1 redesign)", () => {
  it("State 1: succeeded with output renders BOTH Summary and Details cards", () => {
    const onSwitchTab = vi.fn();
    const task = makeTask({
      status: "succeeded",
      success: { output: "Done. PR opened at **https://example/pr/1**." },
    });
    const { container } = render(
      <OverviewTab task={task} activity={null} onSwitchTab={onSwitchTab} />,
    );
    // Summary card present with markdown body.
    expect(screen.getByText("Summary")).toBeTruthy();
    expect(container.querySelector(".md")).toBeTruthy();
    expect(screen.getByText(/Done\./)).toBeTruthy();
    // Details card ALSO present (regression for the early-return bug).
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.getByText("the original brief details")).toBeTruthy();
    // No "No summary" placeholder.
    expect(screen.queryByText(/No summary was produced/)).toBeNull();
  });

  it("State 2: succeeded with empty output → No-summary note + Details card", () => {
    const task = makeTask({ status: "succeeded", success: { output: "" } });
    render(<OverviewTab task={task} activity={null} onSwitchTab={vi.fn()} />);
    expect(screen.getByText(/No summary was produced/)).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.queryByText("Summary")).toBeNull();
  });

  it("State 3: failed → failure callout + Details card", () => {
    const task = makeTask({
      status: "failed",
      failure: { kind: "exited", exit_code: 2, message: "boom" },
    });
    render(<OverviewTab task={task} activity={null} onSwitchTab={vi.fn()} />);
    expect(screen.getByText(/Failure · exited/)).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("exit 2")).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.queryByText("Summary")).toBeNull();
  });

  it("State 4: cancelled → cancellation note + Details card", () => {
    const task = makeTask({
      status: "cancelled",
      cancellation: { kind: "user", message: "user pressed cancel" },
    });
    render(<OverviewTab task={task} activity={null} onSwitchTab={vi.fn()} />);
    expect(screen.getByText("user pressed cancel")).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
  });

  it("State 5: running → activity hint + Details card", () => {
    const task = makeTask({ status: "running" });
    render(<OverviewTab task={task} activity={null} onSwitchTab={vi.fn()} />);
    expect(screen.getByText(/Task is running/)).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.queryByText("Summary")).toBeNull();
  });

  it("succeeded + output + empty details → Summary card alone (no ghost Details card)", () => {
    const task = makeTask({
      status: "succeeded",
      details: "",
      success: { output: "ok" },
    });
    render(<OverviewTab task={task} activity={null} onSwitchTab={vi.fn()} />);
    expect(screen.getByText("Summary")).toBeTruthy();
    expect(screen.queryByText("Details")).toBeNull();
  });
});

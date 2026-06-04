/**
 * List-wrapper tests for `TaskList` — covers the a11y attributes that
 * live on the `<ul>` and `<li>` shells, not on the row body. The
 * row-body shape is tested in `TaskListItem.test.tsx`; page-level
 * integration (selection + delete confirm + re-dispatch + filter
 * forwarding) is covered by the page tests.
 *
 * The two assertions exercised here are load-bearing for Safari +
 * VoiceOver users:
 *
 *  - The explicit `role="list"` on each `<ul>` is required because
 *    `list-style: none` on `.task-list` causes Safari to strip the
 *    implicit listitem role from `<li>` children, which loses list
 *    semantics entirely. jsdom does NOT replicate Safari's role-
 *    stripping, so we assert the attribute literally — `getByRole`
 *    alone would resolve a bare `<ul>` and silently miss a regression.
 *  - `aria-posinset` + `aria-setsize` on each `<li>` are scoped to the
 *    row's visible group (Running OR Completed — NOT the cross-group
 *    total), per spec §9.6. The parent `TaskList` derives them from
 *    the per-group `tasks.map((t, idx, arr) => ...)` iteration.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskStatus } from "../../../src/api";
import { TaskList } from "../../../src/components/tasks/TaskList";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-default",
    agent: "emploke/dev",
    brief: "Task brief",
    origin: "standalone",
    status: "succeeded" as TaskStatus,
    metadata: { runtime: "copilot" },
    createdAt: "2026-05-01T00:00:00Z",
    startedAt: "2026-05-01T00:01:00Z",
    endedAt: "2026-05-01T00:05:00Z",
    ...overrides,
  };
}

function renderList(tasks: TaskRecord[]) {
  return render(
    <TaskList
      tasks={tasks}
      selectedId={null}
      onSelect={vi.fn()}
      onDelete={vi.fn()}
      onCancel={vi.fn().mockResolvedValue(undefined)}
      onRerun={vi.fn()}
    />,
  );
}

afterEach(() => cleanup());

describe("TaskList — explicit role='list' per group", () => {
  it("Running group <ul> carries an explicit role='list' attribute", () => {
    renderList([makeTask({ id: "task-r1", status: "running" })]);
    const list = screen.getByRole("list", { name: /running tasks/i });
    expect(list.tagName).toBe("UL");
    // Literal attribute check — `getByRole("list")` would resolve a
    // bare <ul> in jsdom even without the explicit attribute, so this
    // assertion is what actually documents the Safari-workaround intent.
    expect(list.getAttribute("role")).toBe("list");
  });

  it("Completed group <ul> carries an explicit role='list' attribute", () => {
    renderList([makeTask({ id: "task-c1", status: "succeeded" })]);
    const list = screen.getByRole("list", { name: /completed tasks/i });
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("role")).toBe("list");
  });
});

describe("TaskList — aria-posinset / aria-setsize are per-group", () => {
  it("running rows are numbered 1..N within the Running group", () => {
    const tasks = [
      makeTask({ id: "r-1", brief: "r1", status: "running" }),
      makeTask({ id: "r-2", brief: "r2", status: "running" }),
      makeTask({ id: "r-3", brief: "r3", status: "running" }),
    ];
    renderList(tasks);
    const runningList = screen.getByRole("list", { name: /running tasks/i });
    const items = within(runningList).getAllByRole("listitem");
    expect(items.length).toBe(3);
    expect(items[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(items[0]?.getAttribute("aria-setsize")).toBe("3");
    expect(items[1]?.getAttribute("aria-posinset")).toBe("2");
    expect(items[1]?.getAttribute("aria-setsize")).toBe("3");
    expect(items[2]?.getAttribute("aria-posinset")).toBe("3");
    expect(items[2]?.getAttribute("aria-setsize")).toBe("3");
  });

  it("completed rows are numbered 1..N within the Completed group (separate from running)", () => {
    const tasks = [
      makeTask({ id: "r-1", brief: "r1", status: "running" }),
      makeTask({ id: "c-1", brief: "c1", status: "succeeded" }),
      makeTask({ id: "c-2", brief: "c2", status: "failed" }),
    ];
    renderList(tasks);
    const runningList = screen.getByRole("list", { name: /running tasks/i });
    const completedList = screen.getByRole("list", { name: /completed tasks/i });

    const runningItems = within(runningList).getAllByRole("listitem");
    expect(runningItems.length).toBe(1);
    expect(runningItems[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(runningItems[0]?.getAttribute("aria-setsize")).toBe("1");

    const completedItems = within(completedList).getAllByRole("listitem");
    expect(completedItems.length).toBe(2);
    // setsize is the GROUP size (2), not the cross-group total (3).
    expect(completedItems[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(completedItems[0]?.getAttribute("aria-setsize")).toBe("2");
    expect(completedItems[1]?.getAttribute("aria-posinset")).toBe("2");
    expect(completedItems[1]?.getAttribute("aria-setsize")).toBe("2");
  });
});

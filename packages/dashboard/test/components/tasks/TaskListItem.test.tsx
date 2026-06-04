/**
 * Row-level tests for `TaskListItem` — exercises the per-row select
 * affordance and the `⋯` action menu in isolation (no router, no page
 * state, no API mocks). The page-level integration cases (delete
 * confirm flow, re-dispatch re-opens the dispatch modal, single-open
 * coordination across rows) live in the corresponding page tests.
 *
 * Covers the post-listbox-migration shape:
 *   - Row root is presentational (no role, no tabindex, no aria-selected).
 *   - Forward-defence DOM invariant: no `button button` nesting.
 *   - Select-button advertises selection via `aria-current="true"`.
 *   - Clicking the select-button calls onSelect; clicking the `⋯`
 *     trigger does NOT.
 *   - Status-aware menuitems & their order.
 *   - Action invocations (Cancel / Re-dispatch / Copy ID / Delete).
 *   - Focus restore on Esc and on menuitem click.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord, TaskStatus } from "../../../src/api";
import { TaskListItem } from "../../../src/components/tasks/TaskListItem";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-a",
    agent: "emploke/dev",
    brief: "Build a thing",
    origin: "standalone",
    status: "succeeded" as TaskStatus,
    metadata: { runtime: "copilot" },
    createdAt: "2026-05-01T00:00:00Z",
    startedAt: "2026-05-01T00:01:00Z",
    endedAt: "2026-05-01T00:05:00Z",
    ...overrides,
  };
}

interface RenderOpts {
  task?: TaskRecord;
  selected?: boolean;
  menuOpen?: boolean;
}

function renderRow(opts: RenderOpts = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onCancel: vi.fn().mockResolvedValue(undefined),
    onRerun: vi.fn(),
    onMenuOpenChange: vi.fn(),
  };
  const task = opts.task ?? makeTask();
  // <ul> wrapper because TaskListItem renders an <li>; without it jsdom
  // flags an "li cannot appear as a child of div" warning that obscures
  // real test failures.
  const utils = render(
    <ul>
      <TaskListItem
        task={task}
        selected={opts.selected ?? false}
        onSelect={handlers.onSelect}
        onDelete={handlers.onDelete}
        onCancel={handlers.onCancel}
        onRerun={handlers.onRerun}
        menuOpen={opts.menuOpen ?? false}
        onMenuOpenChange={handlers.onMenuOpenChange}
      />
    </ul>,
  );
  return { ...utils, ...handlers, task };
}

afterEach(() => cleanup());

describe("TaskListItem — row markup (post-listbox migration)", () => {
  it("the row root has no role, no tabindex, no aria-selected", () => {
    renderRow();
    const row = document.querySelector(".task-list__item") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.getAttribute("role")).toBeNull();
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(row.hasAttribute("aria-selected")).toBe(false);
  });

  it("forward-defence: no `button button` nesting inside the row", () => {
    renderRow({ menuOpen: true });
    const row = document.querySelector(".task-list__item") as HTMLElement;
    expect(row.querySelector("button button")).toBeNull();
  });

  it("the select-button advertises selection via aria-current", () => {
    const { rerender, ...handlers } = renderRow({ selected: false });
    const selectBtn = screen.getByRole("button", { name: "Build a thing" });
    expect(selectBtn.getAttribute("aria-current")).toBeNull();
    rerender(
      <ul>
        <TaskListItem
          task={handlers.task}
          selected={true}
          onSelect={handlers.onSelect}
          onDelete={handlers.onDelete}
          onCancel={handlers.onCancel}
          onRerun={handlers.onRerun}
          menuOpen={false}
          onMenuOpenChange={handlers.onMenuOpenChange}
        />
      </ul>,
    );
    expect(screen.getByRole("button", { name: "Build a thing" }).getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("clicking the select-button calls onSelect", () => {
    const { onSelect } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Build a thing" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("clicking the `⋯` trigger calls onMenuOpenChange(true) and does NOT fire onSelect", () => {
    const { onSelect, onMenuOpenChange } = renderRow({ menuOpen: false });
    fireEvent.click(screen.getByRole("button", { name: /Actions for task Build a thing/ }));
    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking the `⋯` trigger while open calls onMenuOpenChange(false)", () => {
    const { onMenuOpenChange } = renderRow({ menuOpen: true });
    fireEvent.click(screen.getByRole("button", { name: /Actions for task Build a thing/ }));
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  it("trigger reflects menuOpen via aria-expanded", () => {
    const { rerender, ...handlers } = renderRow({ menuOpen: false });
    expect(
      screen
        .getByRole("button", { name: /Actions for task Build a thing/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    rerender(
      <ul>
        <TaskListItem
          task={handlers.task}
          selected={false}
          onSelect={handlers.onSelect}
          onDelete={handlers.onDelete}
          onCancel={handlers.onCancel}
          onRerun={handlers.onRerun}
          menuOpen={true}
          onMenuOpenChange={handlers.onMenuOpenChange}
        />
      </ul>,
    );
    expect(
      screen
        .getByRole("button", { name: /Actions for task Build a thing/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("TaskListItem — state-aware menuitems", () => {
  it("for a running task: shows Cancel, Copy ID, Delete (in spec-mandated order)", () => {
    renderRow({ task: makeTask({ status: "running" }), menuOpen: true });
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent?.trim() ?? "");
    expect(items).toEqual(["Cancel", "Copy ID", "Delete"]);
  });

  it("for a terminal task: shows Re-dispatch, Copy ID, Delete (in spec-mandated order)", () => {
    renderRow({ task: makeTask({ status: "succeeded" }), menuOpen: true });
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent?.trim() ?? "");
    expect(items).toEqual(["Re-dispatch", "Copy ID", "Delete"]);
  });

  it("the Delete menuitem carries the --danger class and is last", () => {
    renderRow({ menuOpen: true });
    const items = screen.getAllByRole("menuitem");
    const last = items[items.length - 1];
    expect(last?.textContent?.trim()).toBe("Delete");
    expect(last?.className).toMatch(/task-list__item-menu-option--danger/);
  });
});

describe("TaskListItem — action invocations", () => {
  it("Re-dispatch click calls onRerun and closes the menu — and does NOT fire onSelect", () => {
    const { onRerun, onMenuOpenChange, onSelect } = renderRow({
      task: makeTask({ status: "succeeded" }),
      menuOpen: true,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Re-dispatch$/ }));
    expect(onRerun).toHaveBeenCalledTimes(1);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Cancel click on a running task calls onCancel and eventually closes the menu", async () => {
    const { onCancel, onMenuOpenChange } = renderRow({
      task: makeTask({ status: "running" }),
      menuOpen: true,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Cancel$/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Flush the async finally — onCancel returns a resolved promise.
    await Promise.resolve();
    await Promise.resolve();
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  it("Copy ID click writes the task's id to the clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderRow({ task: makeTask({ id: "task-abc" }), menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy ID$/ }));
    expect(writeText).toHaveBeenCalledWith("task-abc");
  });

  it("Copy ID silently no-ops when clipboard.writeText rejects (SecurityError)", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "SecurityError"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderRow({ menuOpen: true });
    expect(() =>
      fireEvent.click(screen.getByRole("menuitem", { name: /^Copy ID$/ })),
    ).not.toThrow();
    // Flush the rejected promise so unhandled-rejection detectors don't flag.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("Delete click calls onDelete and closes the menu", () => {
    const { onDelete, onMenuOpenChange } = renderRow({ menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("TaskListItem — menu dismissal", () => {
  it("pressing Esc while the menu is open closes it", () => {
    const { onMenuOpenChange } = renderRow({ menuOpen: true });
    // Esc handler is attached to `document` while the menu is open.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  it("clicking outside the row closes the menu (useClickOutside)", () => {
    const { onMenuOpenChange } = renderRow({ menuOpen: true });
    fireEvent.pointerDown(document.body);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("TaskListItem — focus restore", () => {
  it("after pressing Esc, focus returns to the `⋯` trigger", () => {
    renderRow({ menuOpen: true });
    fireEvent.keyDown(document, { key: "Escape" });
    const trigger = screen.getByRole("button", { name: /Actions for task Build a thing/ });
    expect(document.activeElement).toBe(trigger);
  });

  it("after a menuitem action, focus returns to the `⋯` trigger", () => {
    renderRow({ menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/ }));
    const trigger = screen.getByRole("button", { name: /Actions for task Build a thing/ });
    expect(document.activeElement).toBe(trigger);
  });
});

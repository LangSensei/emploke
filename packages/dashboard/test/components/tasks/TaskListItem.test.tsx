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
import { installRectSpy } from "../../_helpers/rectSpy";

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
  posinset?: number;
  setsize?: number;
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
        posinset={opts.posinset ?? 1}
        setsize={opts.setsize ?? 1}
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
          posinset={1}
          setsize={1}
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
          posinset={1}
          setsize={1}
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

describe("TaskListItem — aria-describedby chain (visible-content exposure)", () => {
  it("the row-select button chains status + meta + id via aria-describedby", () => {
    // `aria-labelledby` REPLACES descendant-text concatenation in the
    // accessibility tree, so without a `describedby` chain the screen
    // reader would announce only the brief on focus. Each visible
    // descriptive span gets a stable id and is chained on the button in
    // DOM order; this test asserts that wiring is intact and resolvable.
    renderRow({
      task: makeTask({
        id: "task-xyz",
        agent: "emploke/dev",
        status: "running",
        metadata: { runtime: "copilot" },
      }),
    });
    const selectBtn = screen.getByRole("button", { name: "Build a thing" });
    const describedBy = selectBtn.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const ids = describedBy?.split(/\s+/).filter(Boolean) ?? [];
    // Visible descriptive spans: status pill, meta (agent · runtime · time), id.
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const describingTexts = ids
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .filter(Boolean);
    const joined = describingTexts.join(" ");
    expect(joined).toMatch(/Running/);
    expect(joined).toMatch(/emploke\/dev/);
    expect(joined).toMatch(/copilot/);
    expect(joined).toContain("task-xyz");
  });

  it("the existing `aria-labelledby={headlineId}` still drives the accessible name", () => {
    // Documents that name and description are separate channels: the
    // describedby chain must NOT contaminate the announced name (the
    // existing `getByRole("button", { name: "Build a thing" })` query
    // would resolve a fuzzy match otherwise).
    renderRow();
    const selectBtn = screen.getByRole("button", { name: "Build a thing" });
    expect(selectBtn.getAttribute("aria-labelledby")).toBeTruthy();
  });
});

describe("TaskListItem — aria-posinset / aria-setsize", () => {
  it("li exposes aria-posinset and aria-setsize matching the props", () => {
    renderRow({
      task: makeTask({ id: "task-a" }),
      posinset: 2,
      setsize: 5,
    });
    const li = screen.getByTestId("task-row-task-a");
    expect(li.getAttribute("aria-posinset")).toBe("2");
    expect(li.getAttribute("aria-setsize")).toBe("5");
  });
});

describe("TaskListItem — symmetric task-row-* testids (mirrors schedule-row-*)", () => {
  it("renders task-row-{id} on the <li>, task-row-menu-trigger-{id} on the trigger, and task-row-menu-{id} on the open panel", () => {
    renderRow({ task: makeTask({ id: "task-zebra" }), menuOpen: true });
    expect(screen.getByTestId("task-row-task-zebra").tagName).toBe("LI");
    expect(screen.getByTestId("task-row-menu-trigger-task-zebra").tagName).toBe("BUTTON");
    const menu = screen.getByTestId("task-row-menu-task-zebra");
    expect(menu.getAttribute("role")).toBe("menu");
  });

  it("task-row-menu-{id} is absent while the menu is closed (only the trigger remains)", () => {
    renderRow({ task: makeTask({ id: "task-zebra" }), menuOpen: false });
    expect(screen.queryByTestId("task-row-menu-task-zebra")).toBeNull();
    expect(screen.getByTestId("task-row-menu-trigger-task-zebra")).toBeTruthy();
  });
});

describe("TaskListItem — outside-click deferred focus restore", () => {
  // Spec note: `closeMenu("outside")` defers via setTimeout(0) and only
  // refocuses the trigger when nothing else absorbed the pointerdown
  // (`document.activeElement === document.body`). These assertions
  // exercise the macrotask flush without relying on fake timers (which
  // brittle around React's act() scheduler in this codebase).
  it("outside-click onto a non-focusable area restores focus to the `⋯` trigger after the deferred check", async () => {
    renderRow({ menuOpen: true });
    const trigger = screen.getByRole("button", { name: /Actions for task Build a thing/ });
    // When the menu opens, a useEffect auto-focuses the first menuitem.
    // Reset focus to body (the realistic precondition for the deferred-
    // restore branch — the user clicked away into non-focusable space).
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.pointerDown(document.body);

    // Flush the queued setTimeout(0). The wrapping promise resolves on
    // the next macrotask, after the queued one has fired.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(trigger);
  });

  it("outside-click that focuses another focusable does NOT steal focus back to the `⋯` trigger", async () => {
    // Render the row plus an external focusable. Simulate the natural
    // pointer-focus sequence: pointerdown fires (useClickOutside reacts),
    // then the browser focuses the button. The deferred-restore check
    // must observe activeElement === otherButton (not body) and leave
    // focus alone.
    const handlers = {
      onSelect: vi.fn(),
      onDelete: vi.fn(),
      onCancel: vi.fn().mockResolvedValue(undefined),
      onRerun: vi.fn(),
      onMenuOpenChange: vi.fn(),
    };
    render(
      <div>
        <ul>
          <TaskListItem
            task={makeTask({ id: "task-row-a", brief: "Row A" })}
            selected={false}
            onSelect={handlers.onSelect}
            onDelete={handlers.onDelete}
            onCancel={handlers.onCancel}
            onRerun={handlers.onRerun}
            menuOpen={true}
            onMenuOpenChange={handlers.onMenuOpenChange}
            posinset={1}
            setsize={1}
          />
        </ul>
        <button type="button" data-testid="outside-focusable">
          elsewhere
        </button>
      </div>,
    );
    const triggerA = screen.getByRole("button", { name: /Actions for task Row A/ });
    const elsewhere = screen.getByTestId("outside-focusable") as HTMLButtonElement;

    fireEvent.pointerDown(elsewhere);
    // jsdom does not auto-focus on pointerdown the way real browsers do
    // for `<button>` elements; simulate the natural focus shift directly.
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Deferred-restore must NOT pull focus back to triggerA because
    // activeElement was no longer body when the timeout fired.
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(triggerA);
  });
});

describe("TaskListItem — row-menu placement", () => {
  function makeHandlers() {
    return {
      onSelect: vi.fn(),
      onDelete: vi.fn(),
      onCancel: vi.fn().mockResolvedValue(undefined),
      onRerun: vi.fn(),
      onMenuOpenChange: vi.fn(),
    };
  }

  it("flips an opened menu to `--above` when the next row's trigger would be overlapped", () => {
    // Geometry: row A's trigger at the middle of the viewport, row B's
    // trigger immediately below it, and the panel taller than the gap
    // between them. With the next-sibling-trigger cap, the panel must
    // flip to `--above` rather than overlay row B's trigger.
    const restore = installRectSpy(
      new Map<string, Partial<DOMRect>>([
        // Row A's trigger sits mid-viewport (top:50, bottom:100).
        ["task-row-menu-trigger-task-a", { top: 50, bottom: 100, height: 50 }],
        // Row B's trigger is 10px below row A's — well under the panel height.
        ["task-row-menu-trigger-task-b", { top: 110, bottom: 160, height: 50 }],
        // Panel would need 200px below the trigger to fit; only 10px is
        // available before row B's trigger, so the cap must flip above.
        ["task-row-menu-task-a", { height: 200 }],
      ]),
    );
    try {
      const handlers = makeHandlers();
      render(
        <ul>
          <TaskListItem
            task={makeTask({ id: "task-a", brief: "Row A" })}
            selected={false}
            onSelect={handlers.onSelect}
            onDelete={handlers.onDelete}
            onCancel={handlers.onCancel}
            onRerun={handlers.onRerun}
            menuOpen={true}
            onMenuOpenChange={handlers.onMenuOpenChange}
            posinset={1}
            setsize={2}
          />
          <TaskListItem
            task={makeTask({ id: "task-b", brief: "Row B" })}
            selected={false}
            onSelect={handlers.onSelect}
            onDelete={handlers.onDelete}
            onCancel={handlers.onCancel}
            onRerun={handlers.onRerun}
            menuOpen={false}
            onMenuOpenChange={handlers.onMenuOpenChange}
            posinset={2}
            setsize={2}
          />
        </ul>,
      );
      const panel = screen.getByTestId("task-row-menu-task-a");
      expect(panel.className).toContain("task-list__item-menu-panel--above");
      expect(panel.className).not.toMatch(/task-list__item-menu-panel--below(?:\s|$)/);
    } finally {
      restore();
    }
  });

  it("stays `--below` when the row is last (no next sibling) and there is room beneath the trigger", () => {
    // Last-row fallback: with no next sibling there is no cap to apply,
    // so `viewportBottom` collapses to the scroll container's bottom
    // (or window.innerHeight when no scroll ancestor exists). Trigger
    // sits in the upper viewport with a panel small enough to fit
    // beneath, so the original below-when-space-allows branch runs.
    const restore = installRectSpy(
      new Map<string, Partial<DOMRect>>([
        ["task-row-menu-trigger-task-only", { top: 50, bottom: 100, height: 50 }],
        ["task-row-menu-task-only", { height: 60 }],
      ]),
    );
    try {
      const handlers = makeHandlers();
      render(
        <ul>
          <TaskListItem
            task={makeTask({ id: "task-only", brief: "Only row" })}
            selected={false}
            onSelect={handlers.onSelect}
            onDelete={handlers.onDelete}
            onCancel={handlers.onCancel}
            onRerun={handlers.onRerun}
            menuOpen={true}
            onMenuOpenChange={handlers.onMenuOpenChange}
            posinset={1}
            setsize={1}
          />
        </ul>,
      );
      const panel = screen.getByTestId("task-row-menu-task-only");
      expect(panel.className).toContain("task-list__item-menu-panel--below");
      expect(panel.className).not.toMatch(/task-list__item-menu-panel--above(?:\s|$)/);
    } finally {
      restore();
    }
  });

  it("stays `--below` when a next sibling exists but the cap still leaves room for the panel", () => {
    // Cap-not-binding case: row B's trigger sits far enough below row A
    // that capping `viewportBottom` at row B's top still leaves ample
    // space (>= panelHeight + margin) beneath row A's trigger. The cap
    // is harmless when it isn't binding, so placement stays `--below`.
    const restore = installRectSpy(
      new Map<string, Partial<DOMRect>>([
        ["task-row-menu-trigger-task-a", { top: 50, bottom: 100, height: 50 }],
        // Row B sits 300px below row A's bottom — well above panelHeight + margin.
        ["task-row-menu-trigger-task-b", { top: 400, bottom: 450, height: 50 }],
        ["task-row-menu-task-a", { height: 200 }],
      ]),
    );
    try {
      const handlers = makeHandlers();
      render(
        <ul>
          <TaskListItem
            task={makeTask({ id: "task-a", brief: "Row A" })}
            selected={false}
            onSelect={handlers.onSelect}
            onDelete={handlers.onDelete}
            onCancel={handlers.onCancel}
            onRerun={handlers.onRerun}
            menuOpen={true}
            onMenuOpenChange={handlers.onMenuOpenChange}
            posinset={1}
            setsize={2}
          />
          <TaskListItem
            task={makeTask({ id: "task-b", brief: "Row B" })}
            selected={false}
            onSelect={handlers.onSelect}
            onDelete={handlers.onDelete}
            onCancel={handlers.onCancel}
            onRerun={handlers.onRerun}
            menuOpen={false}
            onMenuOpenChange={handlers.onMenuOpenChange}
            posinset={2}
            setsize={2}
          />
        </ul>,
      );
      const panel = screen.getByTestId("task-row-menu-task-a");
      expect(panel.className).toContain("task-list__item-menu-panel--below");
      expect(panel.className).not.toMatch(/task-list__item-menu-panel--above(?:\s|$)/);
    } finally {
      restore();
    }
  });
});

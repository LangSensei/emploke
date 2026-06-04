/**
 * Row-level tests for `ScheduleListItem` — exercises the per-row `⋯`
 * action menu in isolation (no router, no page state, no API mocks).
 * The page-level integration cases (Edit modal opens, Delete modal
 * confirms, Run-now refreshes the recent-fires panel) live in
 * `SchedulesDetailPage.test.tsx`.
 *
 * Covers the row-level test plan from spec §8:
 *   - Trigger lifecycle (open/close, aria-expanded, Esc)
 *   - State-aware menuitems (Pause vs Resume, Run-now aria-disabled)
 *   - Action invocations
 *   - Row-scoped busy state
 *   - Aria-disabled Run-now no-op
 *   - Event propagation (clicking trigger / menuitem does NOT fire onSelect)
 *   - Paused row visual de-emphasis class
 *   - A11y (aria-pressed, accessible name)
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleView } from "../../../src/api";
import { ScheduleListItem } from "../../../src/components/schedules/ScheduleListItem";

function makeView(overrides: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "sched-a",
    name: "Sample schedule",
    enabled: true,
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: {
      kind: "task",
      agent: "emploke/dev",
      brief: "Do the thing.",
      runtime: "copilot",
    },
    nextFireAt: "2026-05-30T09:00:00.000Z",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-20T00:00:00Z",
    ...overrides,
  };
}

interface RenderOpts {
  schedule?: ScheduleView;
  selected?: boolean;
  menuOpen?: boolean;
  busyAction?: "toggle" | "run" | null;
  posinset?: number;
  setsize?: number;
}

function renderRow(opts: RenderOpts = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onEdit: vi.fn(),
    onToggleEnabled: vi.fn().mockResolvedValue(undefined),
    onRunNow: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn(),
    onMenuOpenChange: vi.fn(),
  };
  const schedule = opts.schedule ?? makeView();
  // <ul> wrapper because ScheduleListItem renders an <li>; otherwise jsdom
  // flags an "li cannot appear as a child of div" warning that obscures
  // real test failures.
  const utils = render(
    <ul>
      <ScheduleListItem
        schedule={schedule}
        selected={opts.selected ?? false}
        onSelect={handlers.onSelect}
        onEdit={handlers.onEdit}
        onToggleEnabled={handlers.onToggleEnabled}
        onRunNow={handlers.onRunNow}
        onDelete={handlers.onDelete}
        busyAction={opts.busyAction ?? null}
        menuOpen={opts.menuOpen ?? false}
        onMenuOpenChange={handlers.onMenuOpenChange}
        posinset={opts.posinset ?? 1}
        setsize={opts.setsize ?? 1}
      />
    </ul>,
  );
  return { ...utils, ...handlers, schedule };
}

afterEach(() => cleanup());

describe("ScheduleListItem — row + trigger", () => {
  it("the row root has no role, no tabindex, no aria-selected (post-listbox migration)", () => {
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
    const selectBtn = screen.getByRole("button", { name: "Sample schedule" });
    expect(selectBtn.getAttribute("aria-current")).toBeNull();
    rerender(
      <ul>
        <ScheduleListItem
          schedule={handlers.schedule}
          selected={true}
          onSelect={handlers.onSelect}
          onEdit={handlers.onEdit}
          onToggleEnabled={handlers.onToggleEnabled}
          onRunNow={handlers.onRunNow}
          onDelete={handlers.onDelete}
          busyAction={null}
          menuOpen={false}
          onMenuOpenChange={handlers.onMenuOpenChange}
          posinset={1}
          setsize={1}
        />
      </ul>,
    );
    expect(
      screen.getByRole("button", { name: "Sample schedule" }).getAttribute("aria-current"),
    ).toBe("true");
  });

  it("clicking the select-button calls onSelect", () => {
    const { onSelect } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Sample schedule" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders the trigger with `aria-label='Actions for schedule {name}'` and `aria-haspopup='menu'`", () => {
    renderRow({ schedule: makeView({ name: "Nightly sync" }) });
    const trigger = screen.getByTestId("schedule-row-menu-trigger-sched-a");
    expect(trigger.getAttribute("aria-label")).toMatch(/Actions for schedule Nightly sync/);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("trigger reflects menuOpen via aria-expanded", () => {
    const { rerender, ...handlers } = renderRow({ menuOpen: false });
    expect(
      screen.getByTestId("schedule-row-menu-trigger-sched-a").getAttribute("aria-expanded"),
    ).toBe("false");
    rerender(
      <ul>
        <ScheduleListItem
          schedule={handlers.schedule}
          selected={false}
          onSelect={handlers.onSelect}
          onEdit={handlers.onEdit}
          onToggleEnabled={handlers.onToggleEnabled}
          onRunNow={handlers.onRunNow}
          onDelete={handlers.onDelete}
          busyAction={null}
          menuOpen={true}
          onMenuOpenChange={handlers.onMenuOpenChange}
          posinset={1}
          setsize={1}
        />
      </ul>,
    );
    expect(
      screen.getByTestId("schedule-row-menu-trigger-sched-a").getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("clicking the trigger calls onMenuOpenChange(true) and NOT onSelect", () => {
    const { onMenuOpenChange, onSelect } = renderRow({ menuOpen: false });
    fireEvent.click(screen.getByTestId("schedule-row-menu-trigger-sched-a"));
    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking the trigger while open calls onMenuOpenChange(false)", () => {
    const { onMenuOpenChange } = renderRow({ menuOpen: true });
    fireEvent.click(screen.getByTestId("schedule-row-menu-trigger-sched-a"));
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  it("pressing Esc while the menu is open closes it (calls onMenuOpenChange(false))", () => {
    const { onMenuOpenChange } = renderRow({ menuOpen: true });
    fireEvent.keyDown(screen.getByTestId("schedule-row-menu-sched-a"), { key: "Escape" });
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  it("clicking outside the row closes the menu (useClickOutside)", () => {
    const { onMenuOpenChange } = renderRow({ menuOpen: true });
    // useClickOutside listens on `pointerdown` in capture phase.
    fireEvent.pointerDown(document.body);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ScheduleListItem — state-aware menuitems", () => {
  it("when enabled: shows Pause menuitem and an interactive Run now", () => {
    renderRow({ schedule: makeView({ enabled: true }), menuOpen: true });
    expect(screen.getByRole("menuitem", { name: /^Pause$/ })).toBeTruthy();
    const runNow = screen.getByRole("menuitem", { name: /^Run now$/ });
    expect(runNow.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("when paused: shows Resume menuitem and an aria-disabled Run now with helper copy", () => {
    renderRow({ schedule: makeView({ enabled: false }), menuOpen: true });
    expect(screen.getByRole("menuitem", { name: /^Resume$/ })).toBeTruthy();
    // The accessible name includes the helper copy so AT users hear it.
    const runNow = screen.getByRole("menuitem", { name: /Run now — resume schedule first/ });
    expect(runNow.getAttribute("aria-disabled")).toBe("true");
    // `aria-disabled` is used INSTEAD of native `disabled` so the
    // menuitem remains keyboard-focusable.
    expect((runNow as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders all menuitems in the spec-mandated order: Run now, Pause/Resume, Edit, Copy ID, Delete", () => {
    renderRow({ menuOpen: true });
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent?.trim() ?? "");
    expect(items).toEqual(["Run now", "Pause", "Edit", "Copy ID", "Delete"]);
  });

  it("the Delete menuitem carries the --danger class and is the last menuitem", () => {
    renderRow({ menuOpen: true });
    const items = screen.getAllByRole("menuitem");
    const last = items[items.length - 1];
    expect(last.textContent?.trim()).toBe("Delete");
    expect(last.className).toMatch(/task-list__item-menu-option--danger/);
  });

  it("Pause menuitem has aria-pressed='true' when schedule.enabled is true", () => {
    renderRow({ schedule: makeView({ enabled: true }), menuOpen: true });
    expect(screen.getByRole("menuitem", { name: /^Pause$/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("Resume menuitem has aria-pressed='false' when schedule.enabled is false", () => {
    renderRow({ schedule: makeView({ enabled: false }), menuOpen: true });
    expect(screen.getByRole("menuitem", { name: /^Resume$/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

describe("ScheduleListItem — action invocations", () => {
  it("Edit click calls onEdit and closes the menu — and does NOT fire onSelect", () => {
    const { onEdit, onMenuOpenChange, onSelect } = renderRow({ menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit$/ }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Pause click calls onToggleEnabled and closes the menu", () => {
    const { onToggleEnabled, onMenuOpenChange } = renderRow({ menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Pause$/ }));
    expect(onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });

  it("Run now click on an enabled schedule calls onRunNow", () => {
    const { onRunNow } = renderRow({ schedule: makeView({ enabled: true }), menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Run now$/ }));
    expect(onRunNow).toHaveBeenCalledTimes(1);
  });

  it("Run now click on a paused schedule is a no-op (does NOT call onRunNow)", () => {
    const { onRunNow } = renderRow({ schedule: makeView({ enabled: false }), menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /Run now — resume schedule first/ }));
    expect(onRunNow).not.toHaveBeenCalled();
  });

  it("Copy ID click writes the schedule's id to the clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderRow({ schedule: makeView({ id: "sched-abc" }), menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy ID$/ }));
    expect(writeText).toHaveBeenCalledWith("sched-abc");
  });

  it("Copy ID silently no-ops when clipboard.writeText rejects (SecurityError)", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "SecurityError"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderRow({ menuOpen: true });
    // No throw — the click handler swallows clipboard rejections.
    expect(() =>
      fireEvent.click(screen.getByRole("menuitem", { name: /^Copy ID$/ })),
    ).not.toThrow();
    // Flush the rejected promise so unhandled-rejection detectors don't flag.
    await Promise.resolve();
  });

  it("Delete click calls onDelete and closes the menu", () => {
    const { onDelete, onMenuOpenChange } = renderRow({ menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onMenuOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ScheduleListItem — row-scoped busy state", () => {
  it("when busyAction='toggle': Pause/Resume/Run now/Edit/Delete are all disabled", () => {
    renderRow({ menuOpen: true, busyAction: "toggle" });
    // Pause label flips to a busy form when busy via toggle.
    expect(screen.getByRole("menuitem", { name: /Pausing…|Pause/ })).toBeTruthy();
    for (const name of [/^Run now$/, /^Pause$|Pausing…/, /^Edit$/, /^Delete$/]) {
      const item = screen.getByRole("menuitem", { name });
      expect((item as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("when busyAction='run': Pause/Resume/Run now/Edit/Delete are all disabled", () => {
    renderRow({ menuOpen: true, busyAction: "run" });
    for (const name of [/^Run now$|Dispatching…/, /^Pause$/, /^Edit$/, /^Delete$/]) {
      const item = screen.getByRole("menuitem", { name });
      expect((item as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("when busyAction=null: no menuitems are disabled", () => {
    renderRow({ menuOpen: true, busyAction: null });
    for (const item of screen.getAllByRole("menuitem")) {
      // Run-now on enabled schedule must NOT be disabled.
      // aria-disabled may still be set on Run-now if paused; the default
      // fixture is enabled so neither attribute should be true here.
      expect((item as HTMLButtonElement).disabled).toBe(false);
      expect(item.getAttribute("aria-disabled")).not.toBe("true");
    }
  });
});

describe("ScheduleListItem — paused-row visual de-emphasis", () => {
  it("a paused row has the `task-list__item--paused` class", () => {
    renderRow({ schedule: makeView({ enabled: false }) });
    const row = screen.getByTestId("schedule-row-sched-a");
    expect(row.className).toMatch(/task-list__item--paused/);
  });

  it("an enabled row does NOT have `task-list__item--paused`", () => {
    renderRow({ schedule: makeView({ enabled: true }) });
    const row = screen.getByTestId("schedule-row-sched-a");
    expect(row.className).not.toMatch(/task-list__item--paused/);
  });
});

describe("ScheduleListItem — preserved list-page contract", () => {
  it("the row root preserves the `schedule-row-{id}` testid (so SchedulesListPage tests keep passing)", () => {
    renderRow({ schedule: makeView({ id: "sched-zebra" }) });
    expect(screen.getByTestId("schedule-row-sched-zebra")).toBeTruthy();
  });

  it("the row still surfaces the Enabled / Paused badge text", () => {
    const { rerender, ...handlers } = renderRow({ schedule: makeView({ enabled: true }) });
    expect(screen.getAllByText(/Enabled/i).length).toBeGreaterThan(0);
    rerender(
      <ul>
        <ScheduleListItem
          schedule={makeView({ enabled: false })}
          selected={false}
          onSelect={handlers.onSelect}
          onEdit={handlers.onEdit}
          onToggleEnabled={handlers.onToggleEnabled}
          onRunNow={handlers.onRunNow}
          onDelete={handlers.onDelete}
          busyAction={null}
          menuOpen={false}
          onMenuOpenChange={handlers.onMenuOpenChange}
          posinset={1}
          setsize={1}
        />
      </ul>,
    );
    expect(screen.getAllByText(/Paused/i).length).toBeGreaterThan(0);
  });
});

describe("ScheduleListItem — focus restore", () => {
  it("after pressing Esc, focus returns to the `⋯` trigger", () => {
    renderRow({ menuOpen: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByTestId("schedule-row-menu-trigger-sched-a"));
  });

  it("after a menuitem action, focus returns to the `⋯` trigger", () => {
    renderRow({ menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Edit$/ }));
    expect(document.activeElement).toBe(screen.getByTestId("schedule-row-menu-trigger-sched-a"));
  });
});

describe("ScheduleListItem — aria-describedby chain (visible-content exposure)", () => {
  it("the row-select button chains status + meta via aria-describedby", () => {
    // `aria-labelledby` REPLACES descendant-text concatenation in the
    // accessibility tree, so without a `describedby` chain the screen
    // reader would announce only the schedule name on focus. Each
    // visible descriptive span gets a stable id and is chained on the
    // button in DOM order.
    renderRow({
      schedule: makeView({
        id: "sched-x",
        name: "Nightly sync",
        enabled: true,
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        target: { kind: "task", agent: "emploke/dev", brief: "x", runtime: "copilot" },
      }),
    });
    const selectBtn = screen.getByRole("button", { name: "Nightly sync" });
    const describedBy = selectBtn.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const ids = describedBy?.split(/\s+/).filter(Boolean) ?? [];
    // Visible descriptive spans on a Schedules row: status badge, meta
    // wrapper (cron · agent · runtime · next).
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const describingTexts = ids
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .filter(Boolean);
    const joined = describingTexts.join(" ");
    expect(joined).toMatch(/Enabled/);
    expect(joined).toMatch(/0 9 \* \* \*/);
    expect(joined).toMatch(/emploke\/dev/);
    expect(joined).toMatch(/copilot/);
  });

  it("the existing `aria-labelledby={headlineId}` still drives the accessible name", () => {
    renderRow();
    const selectBtn = screen.getByRole("button", { name: "Sample schedule" });
    expect(selectBtn.getAttribute("aria-labelledby")).toBeTruthy();
  });
});

describe("ScheduleListItem — aria-posinset / aria-setsize", () => {
  it("li exposes aria-posinset and aria-setsize matching the props", () => {
    renderRow({ posinset: 3, setsize: 7 });
    const li = screen.getByTestId("schedule-row-sched-a");
    expect(li.getAttribute("aria-posinset")).toBe("3");
    expect(li.getAttribute("aria-setsize")).toBe("7");
  });
});

describe("ScheduleListItem — outside-click deferred focus restore", () => {
  // Spec note: `closeMenu("outside")` defers via setTimeout(0) and only
  // refocuses the trigger when nothing else absorbed the pointerdown
  // (`document.activeElement === document.body`). These assertions
  // exercise the macrotask flush directly so jsdom can model the
  // deferred-check + don't-steal-focus contract without fake-timer plumbing.
  it("outside-click onto a non-focusable area restores focus to the `⋯` trigger after the deferred check", async () => {
    renderRow({ menuOpen: true });
    const trigger = screen.getByTestId("schedule-row-menu-trigger-sched-a") as HTMLButtonElement;
    // When the menu opens, a useEffect auto-focuses the first menuitem.
    // Reset focus to body (the realistic precondition for the deferred-
    // restore branch — the user clicked away into non-focusable space).
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.pointerDown(document.body);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(trigger);
  });

  it("outside-click that focuses another focusable does NOT steal focus back to the `⋯` trigger", async () => {
    const handlers = {
      onSelect: vi.fn(),
      onEdit: vi.fn(),
      onToggleEnabled: vi.fn().mockResolvedValue(undefined),
      onRunNow: vi.fn().mockResolvedValue(undefined),
      onDelete: vi.fn(),
      onMenuOpenChange: vi.fn(),
    };
    render(
      <div>
        <ul>
          <ScheduleListItem
            schedule={makeView({ id: "sched-a", name: "Row A" })}
            selected={false}
            onSelect={handlers.onSelect}
            onEdit={handlers.onEdit}
            onToggleEnabled={handlers.onToggleEnabled}
            onRunNow={handlers.onRunNow}
            onDelete={handlers.onDelete}
            busyAction={null}
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
    const triggerA = screen.getByTestId("schedule-row-menu-trigger-sched-a");
    const elsewhere = screen.getByTestId("outside-focusable") as HTMLButtonElement;

    fireEvent.pointerDown(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(triggerA);
  });
});

describe("ScheduleListItem — cross-row busy-lock isolation", () => {
  it("a sibling row's `busyAction='toggle'` does not lock this row's menuitems", () => {
    // Row A is busy (mid-flight toggle), row B is idle and has its menu
    // open. Row B's menuitems must remain interactive — busy-lock is
    // strictly per-row, keyed off the row's own `busyAction` prop. The
    // page-level `busyByScheduleId` map ensures this isolation upstream;
    // this row-level test asserts the boundary so a future refactor that
    // accidentally couples sibling rows trips a failure here.
    const handlers = {
      onSelect: vi.fn(),
      onEdit: vi.fn(),
      onToggleEnabled: vi.fn().mockReturnValue(new Promise(() => {})),
      onRunNow: vi.fn().mockResolvedValue(undefined),
      onDelete: vi.fn(),
      onMenuOpenChange: vi.fn(),
    };
    render(
      <ul>
        <ScheduleListItem
          schedule={makeView({ id: "sched-a", name: "Row A" })}
          selected={false}
          onSelect={handlers.onSelect}
          onEdit={handlers.onEdit}
          onToggleEnabled={handlers.onToggleEnabled}
          onRunNow={handlers.onRunNow}
          onDelete={handlers.onDelete}
          busyAction="toggle"
          menuOpen={false}
          onMenuOpenChange={handlers.onMenuOpenChange}
          posinset={1}
          setsize={2}
        />
        <ScheduleListItem
          schedule={makeView({ id: "sched-b", name: "Row B" })}
          selected={false}
          onSelect={handlers.onSelect}
          onEdit={handlers.onEdit}
          onToggleEnabled={handlers.onToggleEnabled}
          onRunNow={handlers.onRunNow}
          onDelete={handlers.onDelete}
          busyAction={null}
          menuOpen={true}
          onMenuOpenChange={handlers.onMenuOpenChange}
          posinset={2}
          setsize={2}
        />
      </ul>,
    );
    // Only row B has a rendered menu (menuOpen=true). Every menuitem in
    // it must be interactive regardless of row A's busy state.
    const menuB = screen.getByTestId("schedule-row-menu-sched-b");
    const items = Array.from(menuB.querySelectorAll('[role="menuitem"]'));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect((item as HTMLButtonElement).disabled).toBe(false);
      expect(item.getAttribute("aria-disabled")).not.toBe("true");
    }
  });
});

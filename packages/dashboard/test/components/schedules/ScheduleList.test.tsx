/**
 * List-wrapper tests for `ScheduleList` — covers the a11y attributes
 * that live on the `<ul>` and `<li>` shells, not on the row body. The
 * row-body shape is tested in `ScheduleListItem.test.tsx`; page-level
 * integration is covered by `SchedulesListPage.test.tsx`.
 *
 * The explicit `role="list"` is required because `list-style: none` on
 * `.task-list` causes Safari + VoiceOver to strip the implicit
 * listitem role from `<li>` children, losing list semantics entirely.
 * jsdom does NOT replicate Safari's role-stripping, so we assert the
 * attribute literally — `getByRole` alone would resolve a bare `<ul>`
 * and silently miss a regression.
 *
 * `aria-posinset` + `aria-setsize` on each `<li>` are scoped to the
 * full schedules list (there is no grouping on the Schedules page); the
 * parent `ScheduleList` derives them from `schedules.map((s, idx, arr)
 * => ...)`.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduleView } from "../../../src/api";
import { ScheduleList } from "../../../src/components/schedules/ScheduleList";

function makeView(overrides: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "sched-default",
    name: "Default schedule",
    enabled: true,
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    target: { kind: "task", agent: "emploke/dev", brief: "x", runtime: "copilot" },
    nextFireAt: "2026-05-30T09:00:00.000Z",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-20T00:00:00Z",
    ...overrides,
  };
}

function renderList(schedules: ScheduleView[]) {
  return render(
    <ScheduleList
      schedules={schedules}
      selectedId={null}
      onSelect={vi.fn()}
      onEdit={vi.fn()}
      onToggleEnabled={vi.fn().mockResolvedValue(undefined)}
      onRunNow={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn()}
      busyByScheduleId={{}}
      openMenuId={null}
      onMenuOpenChange={vi.fn()}
    />,
  );
}

afterEach(() => cleanup());

describe("ScheduleList — explicit role='list'", () => {
  it("the root <ul> carries an explicit role='list' attribute and aria-label='Schedules'", () => {
    renderList([makeView({ id: "s-1", name: "One" })]);
    const list = screen.getByRole("list", { name: /schedules/i });
    expect(list.tagName).toBe("UL");
    // Literal attribute check — `getByRole("list")` would resolve a
    // bare <ul> in jsdom even without the explicit attribute, so this
    // assertion documents the Safari-workaround intent.
    expect(list.getAttribute("role")).toBe("list");
  });
});

describe("ScheduleList — aria-posinset / aria-setsize across rows", () => {
  it("each <li> is numbered 1..N with the same setsize matching the total", () => {
    const schedules = [
      makeView({ id: "s-1", name: "One" }),
      makeView({ id: "s-2", name: "Two" }),
      makeView({ id: "s-3", name: "Three" }),
    ];
    renderList(schedules);
    const list = screen.getByRole("list", { name: /schedules/i });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBe(3);
    expect(items[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(items[1]?.getAttribute("aria-posinset")).toBe("2");
    expect(items[2]?.getAttribute("aria-posinset")).toBe("3");
    for (const li of items) {
      expect(li.getAttribute("aria-setsize")).toBe("3");
    }
  });
});

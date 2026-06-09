import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHeaderWire } from "../../../src/api";
import { WorkflowListItem } from "../../../src/components/workflows/WorkflowListItem";

function makeWorkflow(overrides: Partial<WorkflowHeaderWire> = {}): WorkflowHeaderWire {
  return {
    id: "wf-default-123456",
    brief: "Default workflow",
    status: "running",
    coordinatorAgent: "emploke/dev",
    metadata: {},
    createdAt: "2026-05-28T00:00:00.000Z",
    iterationCount: 2,
    ...overrides,
  };
}

interface RenderOpts {
  selected?: boolean;
  menuOpen?: boolean;
}

function renderRow(overrides: Partial<WorkflowHeaderWire> = {}, opts: RenderOpts = {}) {
  const { selected = false, menuOpen = false } = opts;
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const onMenuOpenChange = vi.fn();
  const wf = makeWorkflow(overrides);
  render(
    <ul>
      <WorkflowListItem
        workflow={wf}
        selected={selected}
        onSelect={onSelect}
        onCancel={onCancel}
        menuOpen={menuOpen}
        onMenuOpenChange={onMenuOpenChange}
        posinset={1}
        setsize={1}
      />
    </ul>,
  );
  return { wf, onSelect, onCancel, onMenuOpenChange };
}

afterEach(() => cleanup());

describe("WorkflowListItem — selection + click", () => {
  it("invokes onSelect when the row select button is clicked", () => {
    const { wf, onSelect } = renderRow();
    fireEvent.click(
      screen.getByTestId(`workflow-row-${wf.id}`).querySelector(".task-list__item-select")!,
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("adds the selected modifier class + aria-current when selected", () => {
    const { wf } = renderRow({}, { selected: true });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.className).toContain("task-list__item--selected");
    const btn = row.querySelector(".task-list__item-select");
    expect(btn?.getAttribute("aria-current")).toBe("true");
  });

  it("does not add the selected class when not selected", () => {
    const { wf } = renderRow({}, { selected: false });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.className).not.toContain("task-list__item--selected");
    expect(row.querySelector(".task-list__item-select")?.getAttribute("aria-current")).toBeNull();
  });
});

describe("WorkflowListItem — meta rendering", () => {
  it("renders the full workflow id on its own row (matches Tasks row-4 pattern)", () => {
    // v2.3: the row carries the full workflow id (mono, muted) on its
    // own line below the meta sentence — same shape as TaskListItem's
    // row-4 `<code class="task-list__id task-list__id--muted">`. The
    // v2.2 shortened (8-char) id in the meta sentence was removed.
    const { wf } = renderRow({ id: "wf-thisismorethan8chars" });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    const idCode = row.querySelector("code.task-list__id");
    expect(idCode?.textContent).toBe("wf-thisismorethan8chars");
  });

  it("renders the coordinator agent in the row meta", () => {
    const { wf } = renderRow({ coordinatorAgent: "emploke/review" });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.textContent).toContain("emploke/review");
  });

  it("renders smart relative time (running → 'running for X') in the row meta", () => {
    // v2.4: row time uses the shared `RelativeTime` component
    // (`components/common/RelativeTime`). Branching: running with
    // `startedAt` → "running for X" (live elapsed), not the v2.2 "Started X ago" against createdAt.
    const { wf } = renderRow({
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.textContent).toMatch(/running for/);
    expect(row.textContent).not.toMatch(/Started /);
  });

  it("renders smart relative time (terminal → 'ran X · ended Y ago') in the row meta", () => {
    const start = new Date(Date.now() - 10 * 60_000).toISOString();
    const end = new Date(Date.now() - 60_000).toISOString();
    const { wf } = renderRow({ status: "succeeded", startedAt: start, endedAt: end });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.textContent).toMatch(/ran .* · ended /);
  });

  it("does NOT render an iteration-count chip in the row meta (v2.2)", () => {
    // Iter chip was removed in v2.2. Phase depth lives in the detail
    // pane's WorkflowMetaStats now. Guarding here prevents a future
    // regression that reintroduces the row-level chip.
    const { wf } = renderRow({ iterationCount: 7 });
    const row = screen.getByTestId(`workflow-row-${wf.id}`);
    expect(row.textContent).not.toContain("iter 7");
    expect(row.textContent).not.toContain("iter ");
  });
});

describe("WorkflowListItem — row `⋯` menu", () => {
  it("clicking the trigger toggles menuOpen via onMenuOpenChange(true)", () => {
    const { wf, onMenuOpenChange } = renderRow();
    fireEvent.click(screen.getByTestId(`workflow-row-menu-trigger-${wf.id}`));
    expect(onMenuOpenChange).toHaveBeenCalledTimes(1);
    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
  });

  it("does NOT bubble the trigger click into onSelect (stopPropagation)", () => {
    const { wf, onSelect } = renderRow();
    fireEvent.click(screen.getByTestId(`workflow-row-menu-trigger-${wf.id}`));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("menuOpen=false → panel is absent", () => {
    const { wf } = renderRow({}, { menuOpen: false });
    expect(screen.queryByTestId(`workflow-row-menu-${wf.id}`)).toBeNull();
  });

  it("menuOpen=true → panel + Cancel + Copy ID menuitems are rendered", () => {
    const { wf } = renderRow({ status: "running" }, { menuOpen: true });
    expect(screen.getByTestId(`workflow-row-menu-${wf.id}`)).toBeTruthy();
    expect(screen.getByTestId(`workflow-row-menu-cancel-${wf.id}`)).toBeTruthy();
    expect(screen.getByTestId(`workflow-row-menu-copy-id-${wf.id}`)).toBeTruthy();
  });

  it("row-menu Cancel label is bare 'Cancel' (Tasks parity, not 'Cancel workflow')", () => {
    // v2.4.2: the row-menu label matches the Tasks pattern exactly
    // (`TaskListItem.tsx` row menu uses bare "Cancel"). The noun is
    // reintroduced in the modal title + primary button where the
    // popover-from-anywhere context makes the disambiguation useful.
    const { wf } = renderRow({ status: "running" }, { menuOpen: true });
    expect(screen.getByTestId(`workflow-row-menu-cancel-${wf.id}`).textContent?.trim()).toBe(
      "Cancel",
    );
  });

  it("row-menu Cancel label on terminal status is 'Cancel — already terminal'", () => {
    // Terminal-state disabled label keeps the same Tasks-parity shape
    // (bare "Cancel" + dash-prefixed status hint).
    const { wf } = renderRow({ status: "succeeded" }, { menuOpen: true });
    expect(screen.getByTestId(`workflow-row-menu-cancel-${wf.id}`).textContent?.trim()).toBe(
      "Cancel — already terminal",
    );
  });

  it("Cancel menuitem fires onCancel(workflow) when status is running", () => {
    const { wf, onCancel, onMenuOpenChange } = renderRow({ status: "running" }, { menuOpen: true });
    fireEvent.click(screen.getByTestId(`workflow-row-menu-cancel-${wf.id}`));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith(wf);
    // Menu also closes after a menuitem activation.
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("Cancel menuitem is aria-disabled + no-op for terminal workflows", () => {
    const { wf, onCancel, onMenuOpenChange } = renderRow(
      { status: "succeeded" },
      { menuOpen: true },
    );
    const cancel = screen.getByTestId(`workflow-row-menu-cancel-${wf.id}`);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onMenuOpenChange).not.toHaveBeenCalled();
  });

  it("Copy ID writes the workflow id to the clipboard and closes the menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      const { wf, onMenuOpenChange } = renderRow({}, { menuOpen: true });
      fireEvent.click(screen.getByTestId(`workflow-row-menu-copy-id-${wf.id}`));
      // Wait for the awaited writeText to settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(wf.id);
      expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("Escape closes the menu via onMenuOpenChange(false)", () => {
    const { wf, onMenuOpenChange } = renderRow({}, { menuOpen: true });
    expect(screen.getByTestId(`workflow-row-menu-${wf.id}`)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("clicking outside both the trigger and panel closes the menu", () => {
    const { wf, onMenuOpenChange } = renderRow({}, { menuOpen: true });
    expect(screen.getByTestId(`workflow-row-menu-${wf.id}`)).toBeTruthy();
    // useClickOutside listens on `pointerdown` (capture phase) so the
    // dismissal lands before any inner button's `click` would.
    fireEvent.pointerDown(document.body);
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("trigger exposes aria-haspopup='menu' and reflects menuOpen via aria-expanded", () => {
    const { wf, rerender } = (() => {
      const onSelect = vi.fn();
      const onCancel = vi.fn();
      const onMenuOpenChange = vi.fn();
      const wf = makeWorkflow();
      const result = render(
        <ul>
          <WorkflowListItem
            workflow={wf}
            selected={false}
            onSelect={onSelect}
            onCancel={onCancel}
            menuOpen={false}
            onMenuOpenChange={onMenuOpenChange}
            posinset={1}
            setsize={1}
          />
        </ul>,
      );
      return { wf, rerender: result.rerender };
    })();
    const trigger = screen.getByTestId(`workflow-row-menu-trigger-${wf.id}`);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    rerender(
      <ul>
        <WorkflowListItem
          workflow={wf}
          selected={false}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          menuOpen={true}
          onMenuOpenChange={vi.fn()}
          posinset={1}
          setsize={1}
        />
      </ul>,
    );
    expect(
      screen.getByTestId(`workflow-row-menu-trigger-${wf.id}`).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

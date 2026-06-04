// TODO(pilot): paste verbatim §3.11.2 text from
// .pilot/active-missions/20260604-row-action-impl/spec.md (§11 (a))
// into the canonical ADR-001 document once located. See follow-up
// issue (to be filed when this PR opens) for tracking.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScheduleView } from "../../api";
import { useClickOutside } from "../../hooks/useClickOutside";
import { formatAbsolute, formatRelative } from "../../utils/time";
import { MoreHorizontalIcon } from "../Icons";

export interface ScheduleListItemProps {
  schedule: ScheduleView;
  selected: boolean;
  onSelect: () => void;

  /**
   * State-aware row actions. The page lifts these handlers up so a
   * row's menu can mutate any schedule without first selecting it
   * (master-list independence — ADR-001 §3.11.2).
   */
  onEdit: () => void;
  onToggleEnabled: () => Promise<void> | void;
  onRunNow: () => Promise<void> | void;
  onDelete: () => void;

  /**
   * Row-scoped busy state. `null` means idle; `"toggle"` means a
   * patch is in flight for THIS row; `"run"` means a dispatch is in
   * flight. Other rows' busy states do not appear here (the page
   * lifts the map and the list forwards each row's slice).
   */
  busyAction: "toggle" | "run" | null;

  /** Page-level single-open coordination: true iff this row's menu is the one open. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

/**
 * One row of the schedule list. Mirrors `TaskListItem` shape — the
 * `⋯` trigger, the controlled popover, the flip-and-size measurement,
 * and the keyboard handlers — but the menuitems are state-aware:
 *
 *   - `Run now` flips label to "Run now — resume schedule first" and
 *     becomes `aria-disabled="true"` when the schedule is paused
 *     (NOT native `disabled`, so the element stays keyboard-focusable
 *     and the inline helper reaches AT users).
 *   - `Pause` / `Resume` label flips on `schedule.enabled` and carries
 *     `aria-pressed={schedule.enabled}` (preserves the detail-pane
 *     button contract for screen readers).
 *   - The Delete menuitem is danger-styled and renders last.
 *
 * Iter-3 of the row-menu pattern: the per-row `⋯` is a controlled
 * popover (state-driven open via `menuOpen` + `onMenuOpenChange`;
 * click-outside via {@link useClickOutside}; Esc to close; absolute-
 * positioned panel so it floats above sibling rows and the detail
 * pane without altering row geometry). Only one row's menu may be
 * open at a time — that single-open coordination is owned by the
 * page (`Schedules.tsx`) rather than by `ScheduleList`, because the
 * action handlers also live at the page level (close-on-success
 * stays local to the same surface).
 */
export function ScheduleListItem({
  schedule,
  selected,
  onSelect,
  onEdit,
  onToggleEnabled,
  onRunNow,
  onDelete,
  busyAction,
  menuOpen,
  onMenuOpenChange,
}: ScheduleListItemProps) {
  const nextLabel = schedule.nextFireAt ? formatRelative(schedule.nextFireAt) : "—";
  const nextTitle = schedule.nextFireAt ? formatAbsolute(schedule.nextFireAt) : "no upcoming fire";

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const refs = useMemo(() => [triggerRef, panelRef], []);

  const closeMenu = useCallback(() => {
    onMenuOpenChange(false);
  }, [onMenuOpenChange]);

  useClickOutside(refs, closeMenu, menuOpen);

  // Iter-4 (C5): flip + size for the row menu so the last visible row's
  // panel isn't clipped by `.tasks-pane__list-scroll` (overflow: auto).
  // Hand-rolled: measure trigger + nearest scrollable ancestor on open,
  // pick "below" if there's room, otherwise "above"; if neither side
  // fits, pick the larger side and cap height so the panel scrolls
  // internally. Re-measure on scroll/resize while open. Ported 1:1
  // from `TaskListItem.tsx` to keep the two row menus visually aligned.
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const [maxHeightPx, setMaxHeightPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const MARGIN = 8;

    const findScrollContainer = (el: HTMLElement | null): HTMLElement | null => {
      let node: HTMLElement | null = el?.parentElement ?? null;
      while (node && node !== document.body) {
        const overflowY = window.getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    };

    const container = findScrollContainer(trigger);
    let cachedPanelHeight: number | null = null;

    const measure = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const containerRect = container?.getBoundingClientRect();
      const viewportTop = containerRect?.top ?? 0;
      const viewportBottom = containerRect?.bottom ?? window.innerHeight;

      if (cachedPanelHeight == null) {
        const prevMaxHeight = panel.style.maxHeight;
        panel.style.maxHeight = "";
        cachedPanelHeight = panel.getBoundingClientRect().height;
        panel.style.maxHeight = prevMaxHeight;
      }
      const panelHeight = cachedPanelHeight;

      const spaceBelow = viewportBottom - triggerRect.bottom;
      const spaceAbove = triggerRect.top - viewportTop;

      if (spaceBelow >= panelHeight + MARGIN) {
        setPlacement("below");
        setMaxHeightPx(null);
      } else if (spaceAbove >= panelHeight + MARGIN) {
        setPlacement("above");
        setMaxHeightPx(null);
      } else if (spaceAbove > spaceBelow) {
        setPlacement("above");
        setMaxHeightPx(Math.max(0, spaceAbove - MARGIN));
      } else {
        setPlacement("below");
        setMaxHeightPx(Math.max(0, spaceBelow - MARGIN));
      }
    };

    measure();

    let raf = 0;
    const onScrollOrResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    const scrollTarget: EventTarget = container ?? window;
    scrollTarget.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      scrollTarget.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, closeMenu]);

  // When the panel opens, move focus into it so ArrowDown/Up can drive
  // keyboard navigation and Esc has a sensible focus target to return to.
  useEffect(() => {
    if (!menuOpen) return;
    const first = panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [menuOpen]);

  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    e.preventDefault();
    const arr = Array.from(items);
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? arr.indexOf(active as HTMLButtonElement) : -1;
    const next =
      e.key === "ArrowDown"
        ? arr[(idx + 1 + arr.length) % arr.length]
        : arr[(idx - 1 + arr.length) % arr.length];
    next?.focus();
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(schedule.id);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — silently no-op */
    }
    closeMenu();
  };

  const rowBusy = busyAction !== null;
  const runNowDisabledByPause = !schedule.enabled;

  const pauseResumeLabel = (() => {
    if (busyAction === "toggle") return schedule.enabled ? "Pausing…" : "Resuming…";
    return schedule.enabled ? "Pause" : "Resume";
  })();

  const runNowLabel = (() => {
    if (busyAction === "run") return "Dispatching…";
    if (runNowDisabledByPause) return "Run now — resume schedule first";
    return "Run now";
  })();

  return (
    <li
      className={`task-list__item${selected ? " task-list__item--selected" : ""}${
        schedule.enabled ? "" : " task-list__item--paused"
      }`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA listbox/option pattern
      role="option"
      tabIndex={0}
      aria-selected={selected}
      data-testid={`schedule-row-${schedule.id}`}
    >
      <div className="task-list__item-head">
        <span
          className={`badge ${schedule.enabled ? "badge--success" : "badge--warn"} badge--with-dot`}
        >
          <span className="badge__dot" aria-hidden="true" />
          {schedule.enabled ? "Enabled" : "Paused"}
        </span>
        <div className="task-list__item-menu">
          <button
            ref={triggerRef}
            type="button"
            className="btn btn--ghost btn--icon task-list__item-menu-trigger"
            aria-label={`Actions for schedule ${schedule.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Actions"
            data-testid={`schedule-row-menu-trigger-${schedule.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onMenuOpenChange(!menuOpen);
            }}
          >
            <MoreHorizontalIcon />
          </button>
          {menuOpen && (
            <div
              ref={panelRef}
              className={`task-list__item-menu-panel task-list__item-menu-panel--${placement}`}
              role="menu"
              data-testid={`schedule-row-menu-${schedule.id}`}
              style={
                maxHeightPx != null
                  ? ({ "--menu-max-height": `${maxHeightPx}px` } as React.CSSProperties)
                  : undefined
              }
              onClick={(e) => e.stopPropagation()}
              onKeyDown={handlePanelKeyDown}
            >
              <button
                type="button"
                role="menuitem"
                className="task-list__item-menu-option"
                aria-disabled={runNowDisabledByPause ? true : undefined}
                disabled={!runNowDisabledByPause && rowBusy}
                onClick={(e) => {
                  e.stopPropagation();
                  if (runNowDisabledByPause) return;
                  if (rowBusy) return;
                  closeMenu();
                  void onRunNow();
                }}
              >
                {runNowLabel}
              </button>
              {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: spec §5d/§7b/acceptance #6 require `aria-pressed` on the Pause/Resume menuitem to preserve the existing detail-pane toggle button's accessibility contract (so screen readers continue to announce the toggle state through the row menu). */}
              <button
                type="button"
                role="menuitem"
                className="task-list__item-menu-option"
                aria-pressed={schedule.enabled}
                disabled={rowBusy}
                onClick={(e) => {
                  e.stopPropagation();
                  if (rowBusy) return;
                  closeMenu();
                  void onToggleEnabled();
                }}
              >
                {pauseResumeLabel}
              </button>
              <button
                type="button"
                role="menuitem"
                className="task-list__item-menu-option"
                disabled={rowBusy}
                onClick={(e) => {
                  e.stopPropagation();
                  if (rowBusy) return;
                  closeMenu();
                  onEdit();
                }}
              >
                Edit
              </button>
              <button
                type="button"
                role="menuitem"
                className="task-list__item-menu-option"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyId();
                }}
              >
                Copy ID
              </button>
              <button
                type="button"
                role="menuitem"
                className="task-list__item-menu-option task-list__item-menu-option--danger"
                disabled={rowBusy}
                onClick={(e) => {
                  e.stopPropagation();
                  if (rowBusy) return;
                  closeMenu();
                  onDelete();
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      <div
        className="task-list__item-headline task-list__item-headline--clamp"
        title={schedule.name}
      >
        {schedule.name}
      </div>
      <div className="task-list__item-meta muted">
        <code
          className="schedule-cron"
          title={`Cron: ${schedule.trigger.expr} (${schedule.trigger.tz})`}
        >
          {schedule.trigger.expr}
        </code>
        <span className="task-list__sep">·</span>
        <span title={`Agent: ${schedule.target.agent}`}>{schedule.target.agent}</span>
        {schedule.target.runtime ? (
          <>
            <span className="task-list__sep">·</span>
            <span title={`Runtime: ${schedule.target.runtime}`}>{schedule.target.runtime}</span>
          </>
        ) : null}
        <span className="task-list__sep">·</span>
        <span className="muted" title={nextTitle}>
          Next {nextLabel}
        </span>
      </div>
    </li>
  );
}

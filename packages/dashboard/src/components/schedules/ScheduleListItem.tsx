import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScheduleView } from "../../api";
import { useClickOutside } from "../../hooks/useClickOutside";
import { formatAbsolute, formatRelative } from "../../utils/time";
import { MoreHorizontalIcon } from "../Icons";

/**
 * Why `closeMenu` takes a reason: the per-row `⋯` menu can close from
 * three distinct intents and each needs a different focus outcome.
 *
 *  - "escape" / "menuitem"  → restore focus to the trigger synchronously.
 *    The trigger always exists in the DOM, so this is safe. For "menuitem"
 *    this prevents focus from falling to `<body>` when the active
 *    menuitem unmounts, and for "escape" it matches the keyboard user's
 *    expectation of returning to where they opened the menu.
 *
 *  - "outside" → defer one tick and only restore focus to the trigger
 *    when the natural pointerdown left focus on `<body>` (i.e. the user
 *    clicked non-focusable space — e.g. the detail pane's padding). If
 *    the click landed on another focusable element (e.g. another row's
 *    `⋯` trigger), leave its natural focus alone so we don't fight the
 *    user's intent to open that other menu.
 */
type CloseReason = "escape" | "menuitem" | "outside";

export interface ScheduleListItemProps {
  schedule: ScheduleView;
  selected: boolean;
  onSelect: () => void;

  /**
   * State-aware row actions. The page lifts these handlers up so any
   * row's menu can act on any schedule without it being selected first
   * (master-list independence — mirrors the Tasks row pattern, so the
   * list is the canonical action surface and the detail pane is the
   * canonical information surface).
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

  /**
   * 1-based position within the visible schedule list. Required so the
   * `<li>` can advertise `aria-posinset` / `aria-setsize` to screen
   * readers — without these, AT users on Safari/VoiceOver hear
   * row content but no positional cues ("row 3 of 7").
   */
  posinset: number;
  /** Total visible rows in the same list as this row. See {@link posinset}. */
  setsize: number;
}

/**
 * One row of the schedule list. The row itself (`<li>`) is presentational;
 * the click affordance is a real `<button class="task-list__item-select">`
 * that carries `aria-current="true"` when selected. The `⋯` action menu
 * lives as a sibling button so the two never nest (no `button button`
 * shape, which would be invalid HTML and confuse assistive tech).
 *
 * The accessible name on the select-button is supplied via
 * `aria-labelledby={headlineId}` so screen readers announce just the
 * schedule name once.
 *
 * Mirrors `TaskListItem` 1:1 — the `⋯` trigger shape, the controlled
 * popover, the flip-and-size measurement, the keyboard handlers, and the
 * focus-restore mechanic on close are the same — so users moving between
 * Tasks and Schedules don't have to re-learn the interaction. The
 * page-level `Schedules.tsx` lifts all four action handlers up, which
 * means any row's menu can mutate any schedule without it being selected
 * first; the list is the canonical *action* surface, the detail pane is
 * the canonical *information* surface.
 *
 * The menuitems are state-aware:
 *
 *   - `Pause` / `Resume` label flips on `schedule.enabled` and the
 *     menuitem carries `aria-pressed={schedule.enabled}` so screen
 *     readers continue to announce the toggle state.
 *   - `Run now` flips to "Run now — resume schedule first" and becomes
 *     `aria-disabled="true"` (NOT native `disabled`, so the element
 *     stays keyboard-focusable and the inline helper text reaches AT
 *     users) when the schedule is paused.
 *   - `Delete` carries the danger class and renders last so it's
 *     visually distinct from the routine actions above it.
 *
 * Mechanics: the `⋯` is a controlled popover (state-driven open via
 * `menuOpen` + `onMenuOpenChange`; click-outside via
 * {@link useClickOutside}; Esc to close; absolute-positioned panel so
 * it floats above sibling rows and the detail pane without altering
 * row geometry). Only one row's menu may be open at a time — that
 * single-open coordination is owned by the page (`Schedules.tsx`)
 * rather than by `ScheduleList`, because the action handlers also
 * live at the page level (close-on-success stays local to the same
 * surface). Focus is restored to the trigger on Esc/menuitem close
 * synchronously and on outside-click only when the click did not land
 * on another focusable element (see `CloseReason` above).
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
  posinset,
  setsize,
}: ScheduleListItemProps) {
  const nextLabel = schedule.nextFireAt ? formatRelative(schedule.nextFireAt) : "—";
  const nextTitle = schedule.nextFireAt ? formatAbsolute(schedule.nextFireAt) : "no upcoming fire";

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const refs = useMemo(() => [triggerRef, panelRef], []);
  const headlineId = useId();
  // Stable IDs for each visible descriptive span. The select-button's
  // accessible NAME comes from `aria-labelledby={headlineId}` (just the
  // schedule name, once), and its accessible DESCRIPTION comes from
  // `aria-describedby` chaining these IDs in DOM order. Without the
  // chain, screen-reader users hear only the schedule name on focus and
  // lose the Enabled/Paused state + cron + agent + runtime + next-fire
  // context entirely, because `aria-labelledby` REPLACES (not augments)
  // descendant-text concatenation in the accessibility tree.
  const statusId = useId();
  const metaId = useId();

  const closeMenu = useCallback(
    (reason: CloseReason) => {
      onMenuOpenChange(false);
      if (reason === "escape" || reason === "menuitem") {
        triggerRef.current?.focus();
        return;
      }
      // "outside": defer until after the browser has settled focus from
      // the pointerdown. If nothing focusable absorbed the click, return
      // focus to the trigger (avoids the body-focus dead end). If another
      // focusable did receive focus (e.g. a sibling row's trigger), leave
      // it — the user clicked there intentionally.
      setTimeout(() => {
        if (document.activeElement === document.body) {
          triggerRef.current?.focus();
        }
      }, 0);
    },
    [onMenuOpenChange],
  );

  const closeOnOutside = useCallback(() => closeMenu("outside"), [closeMenu]);
  useClickOutside(refs, closeOnOutside, menuOpen);

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
      // Cap the lower bound at the next sibling row's `⋯` trigger when
      // present, so the open menu never visually overlays the adjacent
      // trigger. Without this cap, a click on the overlaid trigger would
      // first land on the outside-click handler (closing this menu)
      // instead of opening the next row's menu, which feels broken.
      const nextRowTrigger =
        trigger
          .closest("li")
          ?.nextElementSibling?.querySelector<HTMLElement>(".task-list__item-menu-trigger") ?? null;
      const containerBottom = containerRect?.bottom ?? window.innerHeight;
      const viewportBottom = nextRowTrigger
        ? Math.min(containerBottom, nextRowTrigger.getBoundingClientRect().top)
        : containerBottom;

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
        closeMenu("escape");
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
    closeMenu("menuitem");
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
      data-testid={`schedule-row-${schedule.id}`}
      aria-posinset={posinset}
      aria-setsize={setsize}
    >
      <button
        type="button"
        className="task-list__item-select"
        aria-current={selected ? "true" : undefined}
        aria-labelledby={headlineId}
        aria-describedby={`${statusId} ${metaId}`}
        onClick={onSelect}
      >
        <span id={statusId} className="task-list__item-head">
          <span
            className={`badge ${
              schedule.enabled ? "badge--success" : "badge--warn"
            } badge--with-dot`}
          >
            <span className="badge__dot" aria-hidden="true" />
            {schedule.enabled ? "Enabled" : "Paused"}
          </span>
        </span>
        <span
          id={headlineId}
          className="task-list__item-headline task-list__item-headline--clamp"
          title={schedule.name}
        >
          {schedule.name}
        </span>
        <span id={metaId} className="task-list__item-meta muted">
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
        </span>
      </button>
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
                closeMenu("menuitem");
                void onRunNow();
              }}
            >
              {runNowLabel}
            </button>
            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: `aria-pressed` on the Pause/Resume menuitem preserves the toggle-state announcement the screen-reader contract from PR #312 established, so users hear whether the schedule is currently enabled or paused without needing to open the detail pane. */}
            <button
              type="button"
              role="menuitem"
              className="task-list__item-menu-option"
              aria-pressed={schedule.enabled}
              disabled={rowBusy}
              onClick={(e) => {
                e.stopPropagation();
                if (rowBusy) return;
                closeMenu("menuitem");
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
                closeMenu("menuitem");
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
                closeMenu("menuitem");
                onDelete();
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

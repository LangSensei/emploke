import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TaskRecord } from "../../api";
import { useClickOutside } from "../../hooks/useClickOutside";
import { RelativeTime } from "../common/RelativeTime";
import { MoreHorizontalIcon } from "../Icons";
import { StatusBadge } from "./StatusBadge";
import { readRuntime, STATUS_TONE } from "./shared";

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

export interface TaskListItemProps {
  task: TaskRecord;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  /**
   * For non-terminal tasks the row-level affordance is "Cancel", not
   * "Delete". Opens the page-level cancel-confirm modal; the actual
   * `cancelTask(...)` call lives there.
   */
  onCancel: () => Promise<void> | void;
  /** Re-open the dispatch modal pre-filled from this task. */
  onRerun: () => void;
  /** Page-level single-open coordination: true when this row's menu is the one open. */
  menuOpen: boolean;
  /** Request to open this row's menu (closes any other open one) or close it. */
  onMenuOpenChange: (open: boolean) => void;
  /**
   * 1-based position within the visible group (Running OR Completed —
   * NOT the cross-group total). Required because the parent
   * `TaskList` splits rows into two visual sections; each section is
   * its own set for AT purposes, so positional cues like
   * "row 2 of 5 running" only make sense within a single group.
   */
  posinset: number;
  /** Total visible rows in the same group as this row. See {@link posinset}. */
  setsize: number;
}

/**
 * One row of the task list. The row itself (`<li>`) is presentational;
 * the click affordance is a real `<button class="task-list__item-select">`
 * that carries `aria-current="true"` when selected. The `⋯` action menu
 * lives as a sibling button so the two never nest (no `button button`
 * shape, which would be invalid HTML and confuse assistive tech).
 *
 * Two-row visual hierarchy (rendered inside the select-button):
 *   row 1: status pill (with inline status-tone dot, pulsing only when
 *          running)
 *   row 2: brief (title-prominent, clamped to 2 lines)
 *   row 3: agent · runtime · relative time (muted)
 *   row 4: full id (mono, muted, demoted text-xs, right-aligned)
 *
 * The accessible name on the select-button is supplied via
 * `aria-labelledby={headlineId}` so screen readers announce just the
 * brief once, not the brief plus every visual descendant. (The previous
 * `<li role="option">` shape pulled the brief into the option's name
 * twice — once from the headline text and again from the menu trigger's
 * `aria-label`.)
 *
 * The `⋯` is a controlled popover (state-driven open via `menuOpen` +
 * `onMenuOpenChange`; click-outside via {@link useClickOutside}; Esc to
 * close; absolute-positioned panel so it floats above sibling rows and
 * the detail pane without altering row geometry). Only one row's menu
 * may be open at a time — that single-open coordination is owned by
 * `TaskList`. Focus is restored to the trigger on Esc/menuitem close
 * synchronously and on outside-click only when the click did not land
 * on another focusable element (see `CloseReason` above).
 */
export function TaskListItem({
  task,
  selected,
  onSelect,
  onDelete,
  onCancel,
  onRerun,
  menuOpen,
  onMenuOpenChange,
  posinset,
  setsize,
}: TaskListItemProps) {
  const tone = STATUS_TONE[task.status];
  const isRunning = task.status === "running";
  // Per-row Cancel debounce — rapid double-clicks would fan into N
  // round-trips. Disabling the menu item keeps the affordance honest.
  const [cancelling, setCancelling] = useState(false);
  const runtime = readRuntime(task);
  const headline = task.brief;
  const tooltip = task.details ? `${task.brief}\n\n${task.details}` : task.brief;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const refs = useMemo(() => [triggerRef, panelRef], []);
  const headlineId = useId();
  // Stable IDs for each visible descriptive span. The select-button's
  // accessible NAME comes from `aria-labelledby={headlineId}` (just the
  // brief, once), and its accessible DESCRIPTION comes from
  // `aria-describedby` chaining these IDs in DOM order. Without the
  // chain, screen-reader users hear only the brief on focus and lose
  // status / agent / runtime / time / id context entirely, because
  // `aria-labelledby` REPLACES (not augments) descendant-text
  // concatenation in the accessibility tree.
  const statusId = useId();
  const metaId = useId();
  const idId = useId();

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
  // internally. Re-measure on scroll/resize while open.
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const [maxHeightPx, setMaxHeightPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;

    const MARGIN = 8;

    // Return the nearest ancestor that actually scrolls vertically. Only
    // `auto`/`scroll` qualify — `hidden` clips without scrolling, and
    // treating it as a scroll container mismeasures inside e.g. border-
    // radius cards. Returns null when no scrollable ancestor exists, in
    // which case the viewport (window.innerHeight) is the bounding box.
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

    // Cache the panel's intrinsic height on first measurement so scroll-
    // tick recomputes don't pay another forced-layout read per frame.
    let cachedPanelHeight: number | null = null;

    const measure = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const containerRect = container?.getBoundingClientRect();
      const viewportTop = containerRect?.top ?? 0;
      const viewportBottom = containerRect?.bottom ?? window.innerHeight;

      if (cachedPanelHeight == null) {
        // Natural panel height: temporarily clear any cap so we measure
        // intrinsic height, then restore.
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

    // rAF-throttle: scroll fires many times per frame; coalesce into one
    // recompute per animation frame so we don't force synchronous layout
    // on every tick.
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
      await navigator.clipboard.writeText(task.id);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — silently no-op */
    }
    closeMenu("menuitem");
  };

  return (
    <li
      className={`task-list__item${selected ? " task-list__item--selected" : ""}${
        isRunning ? " task-list__item--running" : ""
      }`}
      data-testid={`task-row-${task.id}`}
      aria-posinset={posinset}
      aria-setsize={setsize}
    >
      <button
        type="button"
        className="task-list__item-select"
        aria-current={selected ? "true" : undefined}
        aria-labelledby={headlineId}
        aria-describedby={`${statusId} ${metaId} ${idId}`}
        onClick={onSelect}
      >
        <span id={statusId} className="task-list__item-head">
          <StatusBadge status={task.status} tone={tone} pulse={isRunning} />
        </span>
        <span
          id={headlineId}
          className="task-list__item-headline task-list__item-headline--clamp"
          title={tooltip}
        >
          {headline}
        </span>
        <span id={metaId} className="task-list__item-meta muted">
          <span title={`Agent: ${task.agent}`}>{task.agent}</span>
          {runtime && (
            <>
              <span className="task-list__sep">·</span>
              <span title={`Runtime: ${runtime}`}>{runtime}</span>
            </>
          )}
          <span className="task-list__sep">·</span>
          <RelativeTime
            status={task.status}
            startedAt={task.startedAt}
            endedAt={task.endedAt}
            createdAt={task.createdAt}
          />
        </span>
        <code id={idId} className="task-list__id task-list__id--muted" title={task.id}>
          {task.id}
        </code>
      </button>
      <div className="task-list__item-menu">
        <button
          ref={triggerRef}
          type="button"
          className="btn btn--ghost btn--icon task-list__item-menu-trigger"
          aria-label={`Actions for task ${task.brief}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Actions"
          data-testid={`task-row-menu-trigger-${task.id}`}
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
            data-testid={`task-row-menu-${task.id}`}
            style={
              maxHeightPx != null
                ? ({ "--menu-max-height": `${maxHeightPx}px` } as React.CSSProperties)
                : undefined
            }
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handlePanelKeyDown}
          >
            {isRunning ? (
              <button
                type="button"
                role="menuitem"
                className="task-list__item-menu-option"
                disabled={cancelling}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (cancelling) return;
                  setCancelling(true);
                  try {
                    await onCancel();
                  } finally {
                    setCancelling(false);
                  }
                  closeMenu("menuitem");
                }}
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="task-list__item-menu-option"
                onClick={(e) => {
                  e.stopPropagation();
                  onRerun();
                  closeMenu("menuitem");
                }}
              >
                Re-dispatch
              </button>
            )}
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
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
                closeMenu("menuitem");
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

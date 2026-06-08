import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WorkflowHeaderWire } from "../../api";
import { useClickOutside } from "../../hooks/useClickOutside";
import { formatAbsolute, formatRelative } from "../../utils/time";
import { MoreHorizontalIcon } from "../Icons";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";

/**
 * Why `closeMenu` takes a reason: the per-row `⋯` menu can close from
 * three distinct intents and each needs a different focus outcome.
 *
 *  - "escape" / "menuitem"  → restore focus to the trigger synchronously.
 *    The trigger always exists in the DOM, so this is safe. For
 *    "menuitem" this prevents focus from falling to `<body>` when the
 *    active menuitem unmounts, and for "escape" it matches the keyboard
 *    user's expectation of returning to where they opened the menu.
 *
 *  - "outside" → defer one tick and only restore focus to the trigger
 *    when the natural pointerdown left focus on `<body>` (i.e. the user
 *    clicked non-focusable space — e.g. the detail pane's padding). If
 *    the click landed on another focusable element (e.g. another row's
 *    `⋯` trigger), leave its natural focus alone so we don't fight the
 *    user's intent to open that other menu.
 *
 * Ported verbatim from `ScheduleListItem.tsx` (which itself is the
 * canonical port of `TaskListItem.tsx`). Keeping the three row
 * components aligned costs little once the pattern is established.
 */
type CloseReason = "escape" | "menuitem" | "outside";

export interface WorkflowListItemProps {
  workflow: WorkflowHeaderWire;
  selected: boolean;
  onSelect: () => void;
  /**
   * Page-supplied row action. Lifted to the page so any row's menu
   * can act on any workflow without it being selected first (master-
   * list independence — mirrors Tasks / Schedules row patterns; the
   * list is the canonical action surface, the detail pane is the
   * canonical information surface).
   */
  onCancel: (target: WorkflowHeaderWire) => void;
  /** Page-level single-open coordination: true iff this row's menu is the one open. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** 1-based position within the visible list (for `aria-posinset`). */
  posinset: number;
  /** Total visible rows (for `aria-setsize`). */
  setsize: number;
}

/**
 * One row of the workflow list. Selection is a real `<button>` so the
 * keyboard contract is unambiguous; the `<li>` itself carries the
 * `aria-posinset` / `aria-setsize` cues that Safari + VoiceOver need
 * to announce row position. The `⋯` action menu lives as a sibling
 * button so the two never nest (no `button button` shape, which would
 * be invalid HTML and confuse assistive tech). Structurally mirrors
 * `components/schedules/ScheduleListItem.tsx` 1:1 — same `⋯` trigger,
 * same controlled popover, same flip-and-size measurement, same
 * keyboard handlers, same focus-restore mechanic — so users moving
 * between Tasks / Schedules / Workflows don't have to re-learn the
 * interaction.
 *
 * Row meta line carries: id (short) · coordinator agent · "Started X"
 * relative time. The v2.1 `iter N` chip was removed in v2.2 — phase
 * depth is shown in the detail-pane `WorkflowMetaChips` instead.
 *
 * Menuitems for v2.2:
 *   - "Cancel workflow" — `aria-disabled="true"` when status is
 *     terminal; fires `onCancel(workflow)` otherwise.
 *   - "Copy ID" — always enabled; clipboard write with silent fallback.
 */
export function WorkflowListItem({
  workflow,
  selected,
  onSelect,
  onCancel,
  menuOpen,
  onMenuOpenChange,
  posinset,
  setsize,
}: WorkflowListItemProps) {
  const shortId = workflow.id.slice(0, 8);
  const startedLabel = formatRelative(workflow.createdAt);
  const startedTitle = formatAbsolute(workflow.createdAt);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const refs = useMemo(() => [triggerRef, panelRef], []);
  const headlineId = useId();
  // Stable IDs for each visible descriptive span. The select-button's
  // accessible NAME comes from `aria-labelledby={headlineId}` (just
  // the workflow brief, once), and its accessible DESCRIPTION comes
  // from `aria-describedby` chaining these IDs in DOM order. Without
  // the chain, screen-reader users hear only the brief on focus and
  // lose the status + id + agent + started context entirely, because
  // `aria-labelledby` REPLACES (not augments) descendant-text
  // concatenation in the accessibility tree.
  const statusId = useId();
  const metaId = useId();

  const closeMenu = useCallback(
    (reason: CloseReason) => {
      onMenuOpenChange(false);
      if (reason === "escape" || reason === "menuitem") {
        triggerRef.current?.focus();
        return;
      }
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

  // Flip + size for the row menu so the last visible row's panel
  // isn't clipped by `.tasks-pane__list-scroll` (overflow: auto).
  // Hand-rolled — measure trigger + nearest scrollable ancestor on
  // open, pick "below" if there's room, otherwise "above"; if neither
  // side fits, pick the larger side and cap height so the panel
  // scrolls internally. Re-measure on scroll/resize while open.
  // Ported 1:1 from `ScheduleListItem.tsx`.
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

  const handlePanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
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
      await navigator.clipboard.writeText(workflow.id);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — silently no-op */
    }
    closeMenu("menuitem");
  };

  const canCancel = workflow.status === "running";

  return (
    <li
      className={`task-list__item${selected ? " task-list__item--selected" : ""}${
        workflow.status === "running" ? " task-list__item--running" : ""
      }`}
      data-testid={`workflow-row-${workflow.id}`}
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
          <WorkflowStatusBadge status={workflow.status} />
        </span>
        <span
          id={headlineId}
          className="task-list__item-headline task-list__item-headline--clamp"
          title={workflow.brief}
        >
          {workflow.brief}
        </span>
        <span id={metaId} className="task-list__item-meta muted">
          <code className="task-list__id" title={`Workflow id: ${workflow.id}`}>
            {shortId}
          </code>
          <span className="task-list__sep">·</span>
          <span title={`Coordinator: ${workflow.coordinatorAgent}`}>
            {workflow.coordinatorAgent}
          </span>
          <span className="task-list__sep">·</span>
          <span className="muted" title={startedTitle}>
            Started {startedLabel}
          </span>
        </span>
      </button>
      <div className="task-list__item-menu">
        <button
          ref={triggerRef}
          type="button"
          className="btn btn--ghost btn--icon task-list__item-menu-trigger"
          aria-label={`Actions for workflow ${workflow.brief}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Actions"
          data-testid={`workflow-row-menu-trigger-${workflow.id}`}
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
            data-testid={`workflow-row-menu-${workflow.id}`}
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
              className="task-list__item-menu-option task-list__item-menu-option--danger"
              aria-disabled={canCancel ? undefined : true}
              data-testid={`workflow-row-menu-cancel-${workflow.id}`}
              onClick={(e) => {
                e.stopPropagation();
                if (!canCancel) return;
                closeMenu("menuitem");
                onCancel(workflow);
              }}
            >
              {canCancel ? "Cancel workflow" : "Cancel workflow — already terminal"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="task-list__item-menu-option"
              data-testid={`workflow-row-menu-copy-id-${workflow.id}`}
              onClick={(e) => {
                e.stopPropagation();
                handleCopyId();
              }}
            >
              Copy ID
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

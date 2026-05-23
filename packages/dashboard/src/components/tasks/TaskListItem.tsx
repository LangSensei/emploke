import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskRecord } from "../../api";
import { useClickOutside } from "../../hooks/useClickOutside";
import { MoreHorizontalIcon } from "../Icons";
import { StatusBadge } from "./StatusBadge";
import { readRuntime, STATUS_TONE } from "./shared";
import { TaskRelativeTime } from "./TaskRelativeTime";

export interface TaskListItemProps {
  task: TaskRecord;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  /**
   * ADR-001 §3.11.1(b): for non-terminal tasks the row-level affordance
   * is "Cancel", not "Delete". Opens the page-level cancel-confirm
   * modal; the actual `cancelTask(...)` call lives there.
   */
  onCancel: () => Promise<void> | void;
  /** Re-open the dispatch modal pre-filled from this task. */
  onRerun: () => void;
  /** Page-level single-open coordination: true when this row's menu is the one open. */
  menuOpen: boolean;
  /** Request to open this row's menu (closes any other open one) or close it. */
  onMenuOpenChange: (open: boolean) => void;
}

/**
 * One row of the task list. Renders as a card-ish flex row so a tall
 * detail panel on the right never stretches it.
 *
 * Two-row visual hierarchy:
 *   row 1: status pill · — spacer — · `⋯` menu (Cancel / Re-dispatch /
 *          Copy ID / Delete, status-aware)
 *   row 2: brief (title-prominent, clamped to 2 lines — bug-bash F7)
 *   row 3: agent · runtime · relative time (muted)
 *   row 4: full id (mono, muted, demoted text-xs, right-aligned —
 *          bug-bash F11; the row title aligns flush-left independently).
 *
 * Iter-3: the per-row `⋯` is a controlled popover (state-driven open
 * via `menuOpen` + `onMenuOpenChange`; click-outside via
 * {@link useClickOutside}; Esc to close; absolute-positioned panel so
 * it floats above sibling rows and the detail pane without altering
 * row geometry). Only one row's menu may be open at a time — that
 * single-open coordination is owned by `TaskList`.
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

  const closeMenu = useCallback(() => {
    onMenuOpenChange(false);
  }, [onMenuOpenChange]);

  useClickOutside(refs, closeMenu, menuOpen);

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
      await navigator.clipboard.writeText(task.id);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — silently no-op */
    }
    closeMenu();
  };

  return (
    <li
      className={`task-list__item${selected ? " task-list__item--selected" : ""}${
        isRunning ? " task-list__item--running" : ""
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
    >
      <div className="task-list__item-head">
        <StatusBadge status={task.status} tone={tone} pulse={isRunning} />
        <div className="task-list__item-menu">
          <button
            ref={triggerRef}
            type="button"
            className="btn btn--ghost btn--icon task-list__item-menu-trigger"
            aria-label={`Actions for task ${task.brief}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Actions"
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
              className="task-list__item-menu-panel"
              role="menu"
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
                    closeMenu();
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
                    closeMenu();
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
                  closeMenu();
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="task-list__item-headline task-list__item-headline--clamp" title={tooltip}>
        {headline}
      </div>
      <div className="task-list__item-meta muted">
        <span title={`Agent: ${task.agent}`}>{task.agent}</span>
        {runtime && (
          <>
            <span className="task-list__sep">·</span>
            <span title={`Runtime: ${runtime}`}>{runtime}</span>
          </>
        )}
        <span className="task-list__sep">·</span>
        <TaskRelativeTime task={task} />
      </div>
      <code className="task-list__id task-list__id--muted" title={task.id}>
        {task.id}
      </code>
    </li>
  );
}

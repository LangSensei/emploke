import { useState } from "react";
import type { TaskRecord } from "../../api";
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
 */
export function TaskListItem({
  task,
  selected,
  onSelect,
  onDelete,
  onCancel,
  onRerun,
}: TaskListItemProps) {
  const tone = STATUS_TONE[task.status];
  const isRunning = task.status === "running";
  // Per-row Cancel debounce — rapid double-clicks would fan into N
  // round-trips. Disabling the menu item keeps the affordance honest.
  const [cancelling, setCancelling] = useState(false);
  const runtime = readRuntime(task);
  const headline = task.brief;
  const tooltip = task.details ? `${task.brief}\n\n${task.details}` : task.brief;

  const closeMenu = (e: React.MouseEvent<HTMLElement>) => {
    const details = (e.currentTarget as HTMLElement).closest("details");
    if (details) details.removeAttribute("open");
  };

  const handleCopyId = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(task.id);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — silently no-op */
    }
    closeMenu(e);
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
        <details
          className="filter-menu task-list__item-menu"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <summary
            className="btn btn--ghost btn--icon task-list__item-menu-trigger"
            aria-label={`Actions for task ${task.brief}`}
            title="Actions"
          >
            <MoreHorizontalIcon />
          </summary>
          <div className="filter-menu__panel" role="menu">
            {isRunning ? (
              <button
                type="button"
                role="menuitem"
                className="filter-menu__option"
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
                  closeMenu(e);
                }}
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="filter-menu__option"
                onClick={(e) => {
                  e.stopPropagation();
                  onRerun();
                  closeMenu(e);
                }}
              >
                Re-dispatch
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="filter-menu__option"
              onClick={handleCopyId}
            >
              Copy ID
            </button>
            <button
              type="button"
              role="menuitem"
              className="filter-menu__option filter-menu__option--danger"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
                closeMenu(e);
              }}
            >
              Delete
            </button>
          </div>
        </details>
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

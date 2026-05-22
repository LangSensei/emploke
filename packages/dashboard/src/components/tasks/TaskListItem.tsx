import { useState } from "react";
import type { TaskRecord } from "../../api";
import { StopIcon, TrashIcon } from "../Icons";
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
}

/**
 * One row of the task list. Renders as a card-ish flex row so a tall
 * detail panel on the right never stretches it.
 *
 * Two-row visual hierarchy:
 *   row 1: status pill · — spacer — · delete/cancel
 *   row 2: brief (title-prominent, clamped to 2 lines — bug-bash F7)
 *   row 3: agent · runtime · relative time (muted)
 *   row 4: full id (mono, muted, demoted text-xs, right-aligned —
 *          bug-bash F11; the row title aligns flush-left independently).
 */
export function TaskListItem({ task, selected, onSelect, onDelete, onCancel }: TaskListItemProps) {
  const tone = STATUS_TONE[task.status];
  const isRunning = task.status === "running";
  // Per-row Cancel debounce — rapid double-clicks would fan into N
  // round-trips. Disabling the button keeps the affordance honest.
  const [cancelling, setCancelling] = useState(false);
  const runtime = readRuntime(task);
  const headline = task.brief;
  const tooltip = task.details ? `${task.brief}\n\n${task.details}` : task.brief;
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
        {isRunning ? (
          <button
            type="button"
            className="btn btn--ghost btn--icon task-list__item-remove"
            onClick={async (e) => {
              e.stopPropagation();
              if (cancelling) return;
              setCancelling(true);
              try {
                await onCancel();
              } finally {
                setCancelling(false);
              }
            }}
            disabled={cancelling}
            aria-label={`Cancel task ${task.brief}`}
            title="Cancel task (sends SIGTERM)"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--icon task-list__item-remove"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={`Delete task ${task.brief}`}
            title="Delete task"
          >
            <TrashIcon />
          </button>
        )}
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

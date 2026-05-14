import type { TaskRecord } from "../../api";
import { TrashIcon } from "../../components/Icons";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";
import { StatusBadge } from "./StatusBadge";
import { STATUS_TONE } from "./status";

interface TaskTableProps {
  tasks: TaskRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (task: TaskRecord) => void;
}

/**
 * Task list render. Plain `<ul>` with the listbox ARIA pattern; each row
 * is a `TaskListItem` (defined below) so a parent re-render only diffs
 * the rows that actually changed instead of the whole list.
 */
export function TaskTable({ tasks, selectedId, onSelect, onDelete }: TaskTableProps) {
  return (
    <ul
      className="task-list"
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA listbox pattern requires role on ul
      role="listbox"
      aria-label="Tasks"
    >
      {tasks.map((t) => (
        <TaskListItem
          key={t.id}
          task={t}
          selected={selectedId === t.id}
          onSelect={() => onSelect(t.id)}
          onDelete={() => onDelete(t)}
        />
      ))}
    </ul>
  );
}

interface TaskListItemProps {
  task: TaskRecord;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

/**
 * One row of the task list. Renders as a card-ish flex row so a tall
 * detail panel on the right never stretches it (which is what the table
 * layout was doing — table rows in a grid cell take the cell's height).
 *
 * Two-row visual hierarchy:
 *   row 1: status pill · agent chip · runtime chip · — spacer — · delete
 *   row 2: instructions (title-prominent) · full id (mono, muted)
 *   row 3: relative time / duration (muted)
 *
 * Instructions are the actual *content* of a task — the id is a
 * disambiguator, not a name. So instructions get the title role and id
 * gets relegated to the subtitle, matching how GitHub Issues shows
 * "title #42" rather than "#42 with title".
 */
function TaskListItem({ task, selected, onSelect, onDelete }: TaskListItemProps) {
  const tone = STATUS_TONE[task.status];
  const isRunning = task.status === "running" || task.status === "not_started";
  const runtime =
    typeof task.metadata?.runtime === "string" ? (task.metadata.runtime as string) : null;
  // Pull the first non-empty line of instructions as the headline,
  // unless the runtime has supplied a shorter display title (Copilot's
  // workspace.yaml `name` / `summary`). Runtime-derived titles are 5-7
  // words sized for list rendering; they're stable (set once when the
  // CLI generates them, then preserved unless the user renames) so
  // they don't shift on poll. Falls through to the instructions
  // first-line for tasks where no title is available yet.
  const runtimeTitle =
    typeof task.metadata?.title === "string" && task.metadata.title.length > 0
      ? (task.metadata.title as string)
      : null;
  const headline =
    runtimeTitle ??
    task.instructions
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ??
    "(empty instructions)";
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
        <button
          type="button"
          className="btn btn--ghost btn--icon task-list__item-remove"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete task"
          title="Delete task"
        >
          <TrashIcon />
        </button>
      </div>
      <div className="task-list__item-headline" title={task.instructions}>
        {headline}
      </div>
      {/* Footer is plain muted text, not chips. Agent + runtime are
          already filterable via the page toolbar; repeating them as
          chips here added visual weight without information value
          and made narrow columns wrap badly. Showing them as inline
          muted text wraps gracefully (looks like a sentence, not a
          broken UI). The id gets its own line at the bottom because
          it's a mono token of fixed size that pairs awkwardly with
          variable-width labels. */}
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
      <code className="task-list__id" title={task.id}>
        {task.id}
      </code>
    </li>
  );
}

/**
 * Smart relative-time line for a task row. Shows the most informative
 * timestamp for each lifecycle stage:
 *   - not_started: "queued 2m ago"
 *   - running: "running for 1m 23s"  (live elapsed)
 *   - terminal: "ran 5m 12s · ended 2h ago"
 * Tooltip carries the absolute timestamp for forensic precision.
 */
function TaskRelativeTime({ task }: { task: TaskRecord }) {
  if (task.status === "not_started") {
    return (
      <span className="muted" title={formatAbsolute(task.createdAt)}>
        queued {formatRelative(task.createdAt)}
      </span>
    );
  }
  if (task.status === "running" && task.startedAt) {
    return (
      <span className="muted" title={formatAbsolute(task.startedAt)}>
        running for {formatDuration(task.startedAt, null)}
      </span>
    );
  }
  if (task.endedAt && task.startedAt) {
    return (
      <span className="muted" title={formatAbsolute(task.endedAt)}>
        ran {formatDuration(task.startedAt, task.endedAt)} · ended {formatRelative(task.endedAt)}
      </span>
    );
  }
  return (
    <span className="muted" title={formatAbsolute(task.createdAt)}>
      created {formatRelative(task.createdAt)}
    </span>
  );
}

import type { TaskRecord } from "../../api";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";

/**
 * Smart relative-time line for a task row. Shows the most informative
 * timestamp for each lifecycle stage:
 *   - running: "running for 1m 23s"  (live elapsed)
 *   - terminal: "ran 5m 12s · ended 2h ago"
 * Tooltip carries the absolute timestamp for forensic precision.
 */
export function TaskRelativeTime({ task }: { task: TaskRecord }) {
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

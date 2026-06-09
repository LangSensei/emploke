import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";

/**
 * Inputs shared by both the Task and Workflow row-meta consumers.
 * Discrete props rather than a record shape so the helper does not
 * depend on either record type (TaskRecord vs WorkflowHeaderWire) —
 * each caller destructures its own record into this prop bag.
 *
 * `status` is typed open (`string`) on purpose: the only value the
 * branching logic looks at is the literal "running" — every other
 * status falls through to the terminal/created branches. Keeping it
 * open avoids forcing this helper to depend on either consumer's
 * status enum.
 */
export interface RelativeTimeProps {
  status: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
}

/**
 * Smart relative-time line shared by row-level meta sentences across
 * Tasks and Workflows. Shows the most informative timestamp for each
 * lifecycle stage:
 *   - running with `startedAt`: "running for 1m 23s" (live elapsed
 *     from start)
 *   - terminal with `startedAt` + `endedAt`: "ran 5m 12s · ended 2h
 *     ago"
 *   - any other shape (queued, terminal-without-start, etc.):
 *     "created X ago" against `createdAt` — the only timestamp every
 *     record is guaranteed to carry.
 *
 * Tooltip carries the absolute timestamp for forensic precision.
 *
 * The branching logic lives here exactly once — call sites pass
 * discrete props rather than a record so the helper is independent
 * of the Task/Workflow record types. The per-page row-level
 * wrappers that existed before v2.4 (`TaskRelativeTime` /
 * `WorkflowRelativeTime`) have been dropped; `TaskListItem` and
 * `WorkflowListItem` invoke this component directly.
 */
export function RelativeTime({ status, startedAt, endedAt, createdAt }: RelativeTimeProps) {
  if (status === "running" && startedAt) {
    return (
      <span className="muted" title={formatAbsolute(startedAt)}>
        running for {formatDuration(startedAt, null)}
      </span>
    );
  }
  if (endedAt && startedAt) {
    return (
      <span className="muted" title={formatAbsolute(endedAt)}>
        ran {formatDuration(startedAt, endedAt)} · ended {formatRelative(endedAt)}
      </span>
    );
  }
  return (
    <span className="muted" title={formatAbsolute(createdAt)}>
      created {formatRelative(createdAt)}
    </span>
  );
}

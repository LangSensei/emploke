import type { ReactNode } from "react";
import type { TaskActivity, TaskFailure, TaskRecord } from "../../../api";
import { formatAbsolute, formatRelative } from "../../../utils/time";
import { MarkdownSummary } from "./MarkdownSummary";

export interface OverviewTabProps {
  task: TaskRecord;
  /** Latest activity payload (poll/SSE). Used to surface the last
   *  observed agent activity timestamp when the task ended as an
   *  orphan — that timestamp is the operator's best clue as to when
   *  the server died. */
  activity: TaskActivity | null;
  /** Switch the parent detail panel to another tab. Used by the
   *  "Jump to Activity" link on the enriched failure callout. */
  onSwitchTab: (tab: "activity") => void;
}

/**
 * Overview tab — the default landing tab for a task.
 *
 * Iter-2 B1 redesign: vertical stack of (optional) state strip +
 * Summary card + Details card. Summary holds `success.output`; Details
 * holds the original `task.details` brief. Metadata (Started, Duration,
 * Origin, Task ID) is intentionally not rendered here — the parent
 * `TaskDetail` head already shows it.
 *
 * Five layout states:
 *   1. Succeeded + output non-empty → Summary + Details (50/50, both scroll)
 *   2. Succeeded + output empty     → "No summary" note + Details
 *   3. Failed                       → Failure callout + Details
 *   4. Cancelled                    → Cancellation note + Details
 *   5. Running / queued / pending   → "Switch to Activity" note + Details
 *
 * Height layout: the tab body fills the parent's height via flex; each
 * present card gets `flex: 1` with `min-height: 0` so its inner content
 * scrolls independently. When both Summary and Details are present they
 * share the space 50/50; otherwise Details fills the remaining height.
 */
export function OverviewTab({ task, activity, onSwitchTab }: OverviewTabProps) {
  const output = typeof task.success?.output === "string" ? task.success.output.trim() : "";
  const hasSummary = output.length > 0;
  const details = task.details?.trim() ?? "";
  const hasDetails = details.length > 0;

  const strip = renderStateStrip({ task, activity, onSwitchTab, hasSummary });

  return (
    <div className="overview-tab">
      {strip}
      {hasSummary && (
        <OverviewCard title="Summary" className="overview-card--summary">
          <MarkdownSummary source={output} />
        </OverviewCard>
      )}
      {hasDetails ? (
        <OverviewCard title="Details" className="overview-card--details">
          <pre className="overview-card__pre">{details}</pre>
        </OverviewCard>
      ) : (
        !hasSummary &&
        strip === null && <p className="overview-tab__no-details muted">No details available.</p>
      )}
    </div>
  );
}

/**
 * Pick the contextual strip rendered above the cards. Returns `null`
 * for the succeeded-with-output state — that state is "pure result, no
 * commentary needed".
 */
function renderStateStrip({
  task,
  activity,
  onSwitchTab,
  hasSummary,
}: {
  task: TaskRecord;
  activity: TaskActivity | null;
  onSwitchTab: (tab: "activity") => void;
  hasSummary: boolean;
}): ReactNode {
  if (task.failure) {
    return (
      <FailureStrip
        failure={task.failure}
        task={task}
        activity={activity}
        onSwitchTab={onSwitchTab}
      />
    );
  }
  if (task.cancellation) {
    return (
      <div className="alert alert--info overview-tab__strip">
        {task.cancellation.message || "Task was cancelled."}
      </div>
    );
  }
  if (task.status === "succeeded") {
    if (hasSummary) return null;
    return (
      <p className="overview-tab__no-summary">
        No summary was produced. View the{" "}
        <button type="button" className="link-button" onClick={() => onSwitchTab("activity")}>
          Activity tab
        </button>{" "}
        for the full agent run.
      </p>
    );
  }
  // Running / queued / pending.
  return (
    <div className="alert alert--info overview-tab__strip overview-tab__running-hint">
      Task is {task.status}. Switch to the{" "}
      <button type="button" className="link-button" onClick={() => onSwitchTab("activity")}>
        Activity tab
      </button>{" "}
      to follow activity.
    </div>
  );
}

/**
 * Pinned-title card with an internally-scrolling body. Both Summary and
 * Details share this chrome so they read as equals.
 */
function OverviewCard({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`overview-card${className ? ` ${className}` : ""}`}>
      <header className="overview-card__head">
        <h3 className="overview-card__title">{title}</h3>
      </header>
      <div className="overview-card__body">{children}</div>
    </section>
  );
}

/**
 * Render a failure callout with a one-line headline + the structured
 * `failure` payload from `@emploke/task` types. Specialised for
 * `kind === 'orphan'` (last-activity timestamp) per the bug-bash
 * brief.
 */
function FailureStrip({
  failure,
  task,
  activity,
  onSwitchTab,
}: {
  failure: TaskFailure;
  task: TaskRecord;
  activity: TaskActivity | null;
  onSwitchTab: (tab: "activity") => void;
}) {
  const lastActivity = pickLastActivityTimestamp(activity, task);
  return (
    <div className="alert alert--error overview-tab__failure-callout">
      <div className="overview-tab__failure-head">
        <strong>Failure · {failure.kind}</strong>
        {failure.kind === "exited" && (
          <span className="overview-tab__failure-chip">exit {failure.exit_code}</span>
        )}
        {failure.kind === "signal" && (
          <span className="overview-tab__failure-chip">signal {failure.signal}</span>
        )}
      </div>
      <p className="overview-tab__failure-message">{failure.message}</p>
      {failure.kind === "orphan" && lastActivity && (
        <p className="overview-tab__failure-meta muted">
          Last activity {formatRelative(lastActivity)}{" "}
          <span title={lastActivity}>at {formatAbsolute(lastActivity)}</span>
        </p>
      )}
      <div className="overview-tab__failure-actions">
        <button type="button" className="link-button" onClick={() => onSwitchTab("activity")}>
          Jump to Activity ↗
        </button>
      </div>
    </div>
  );
}

/**
 * Best-effort "last activity" timestamp:
 *   1. newest seq in the loaded activity page (if any);
 *   2. otherwise `endedAt`, then `startedAt`, then `createdAt`.
 * The activity payload is paginated — when the user hasn't yet
 * scrolled to the head, the newest item we have may not be the
 * newest item overall, but it's still a meaningful lower bound on
 * "when did this task last produce output".
 */
function pickLastActivityTimestamp(activity: TaskActivity | null, task: TaskRecord): string | null {
  const items = activity?.activity ?? [];
  if (items.length > 0) {
    const newest = items[items.length - 1];
    if (newest?.timestamp) return newest.timestamp;
  }
  return task.endedAt ?? task.startedAt ?? task.createdAt ?? null;
}

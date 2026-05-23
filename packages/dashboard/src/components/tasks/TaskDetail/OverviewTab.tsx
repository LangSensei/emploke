import type { TaskActivity, TaskFailure, TaskRecord } from "../../../api";
import { formatAbsolute, formatRelative } from "../../../utils/time";
import { DetailsSidebar } from "./DetailsSidebar";
import { MarkdownSummary } from "./MarkdownSummary";

export interface OverviewTabProps {
  task: TaskRecord;
  /** Latest activity payload (poll/SSE). Used to surface the last
   *  observed agent activity timestamp when the task ended as an
   *  orphan — that timestamp is the operator's best clue as to when
   *  the server died. */
  activity: TaskActivity | null;
  /** Switch the parent detail panel to another tab. Used by the
   *  "Jump to Logs" / "View raw JSON" links on the enriched failure
   *  callout. */
  onSwitchTab: (tab: "logs" | "raw") => void;
}

/**
 * Overview tab — the default landing tab for a task. Two-column layout:
 *
 *   - Left: a "Summary" card. Renders `success.output` as markdown.
 *     Failure / cancellation / running tasks fall back to a richer
 *     panel that surfaces the failure callout and the original brief
 *     (bug-bash iter-1 F5/F10 — the empty white space below the
 *     callout was the most jarring failure-mode visual).
 *   - Right: the {@link DetailsSidebar} (label → value pairs from the
 *     existing TaskRecord ONLY — no Mission-B fields).
 */
export function OverviewTab({ task, activity, onSwitchTab }: OverviewTabProps) {
  return (
    <div className="overview-tab">
      <section className="overview-tab__summary">
        <h3 className="overview-tab__section-title">Summary</h3>
        <SummaryBody task={task} activity={activity} onSwitchTab={onSwitchTab} />
      </section>
      <DetailsSidebar task={task} />
    </div>
  );
}

function SummaryBody({
  task,
  activity,
  onSwitchTab,
}: {
  task: TaskRecord;
  activity: TaskActivity | null;
  onSwitchTab: (tab: "logs" | "raw") => void;
}) {
  const output = typeof task.success?.output === "string" ? task.success.output.trim() : "";
  if (output.length > 0) {
    return <MarkdownSummary source={output} />;
  }
  if (task.failure) {
    return (
      <div className="overview-tab__failure">
        <FailureCallout failure={task.failure} task={task} activity={activity} />
        <FailureContextPanel task={task} onSwitchTab={onSwitchTab} />
        <BriefPanel task={task} />
      </div>
    );
  }
  if (task.cancellation) {
    return (
      <div className="overview-tab__failure">
        <div className="alert alert--info" style={{ margin: 0 }}>
          {task.cancellation.message || "Task was cancelled."}
        </div>
        <BriefPanel task={task} />
      </div>
    );
  }
  // Iter-2 F6: terminal-success with empty `success.output` is the
  // default state today (backend doesn't populate `output` yet). The
  // previous fallback wrongly told the user to "Switch to the Logs tab
  // to follow activity" — but the run has already ended, so there's
  // nothing to follow. Show a neutral placeholder + the brief.
  if (task.status === "succeeded") {
    return (
      <div className="overview-tab__failure">
        <p className="overview-tab__no-summary">
          No summary was produced. View the Activity tab for the full agent run.
        </p>
        <BriefPanel task={task} />
      </div>
    );
  }
  // Running / not-yet-completed tasks: avoid the giant empty card —
  // show a minimal placeholder that points to the live Logs tab and
  // surface the brief below so the reader has something to anchor on
  // (bug-bash iter-1 F10).
  return (
    <div className="overview-tab__failure">
      <div className="alert alert--info overview-tab__running-hint" style={{ margin: 0 }}>
        Task is {task.status}. Switch to the{" "}
        <button type="button" className="link-button" onClick={() => onSwitchTab("logs")}>
          Logs tab
        </button>{" "}
        to follow activity.
      </div>
      <BriefPanel task={task} />
    </div>
  );
}

/**
 * Render a failure callout with a one-line headline + the structured
 * `failure` payload from `@emploke/task` types — no boilerplate, no
 * fabricated fields. Specialised for `kind === 'orphan'` per the
 * bug-bash brief (last-activity timestamp), but every variant gets at
 * least its `kind` + `message` rendered structured rather than a
 * bare paragraph.
 */
function FailureCallout({
  failure,
  task,
  activity,
}: {
  failure: TaskFailure;
  task: TaskRecord;
  activity: TaskActivity | null;
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
    </div>
  );
}

/**
 * Action row below the failure callout offering quick jumps to the
 * sibling tabs operators reach for most often when debugging a failed
 * task. Kept as a separate component so the callout itself stays
 * focused on the structured failure payload.
 */
function FailureContextPanel({
  task,
  onSwitchTab,
}: {
  task: TaskRecord;
  onSwitchTab: (tab: "logs" | "raw") => void;
}) {
  if (!task.failure) return null;
  return (
    <div className="overview-tab__failure-actions">
      <button type="button" className="link-button" onClick={() => onSwitchTab("logs")}>
        Jump to Logs ↗
      </button>
      <button type="button" className="link-button" onClick={() => onSwitchTab("raw")}>
        View raw JSON ↗
      </button>
    </div>
  );
}

function BriefPanel({ task }: { task: TaskRecord }) {
  const brief = task.brief?.trim() ?? "";
  if (brief.length === 0) return null;
  return (
    <section className="overview-tab__brief">
      <h4 className="overview-tab__section-title">Brief</h4>
      <p className="overview-tab__brief-text">{brief}</p>
      {task.details && task.details.trim().length > 0 && (
        <pre className="overview-tab__brief-details">{task.details}</pre>
      )}
    </section>
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

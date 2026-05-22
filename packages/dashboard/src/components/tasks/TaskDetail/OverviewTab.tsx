import type { TaskRecord } from "../../../api";
import { DetailsSidebar } from "./DetailsSidebar";
import { MarkdownSummary } from "./MarkdownSummary";

export interface OverviewTabProps {
  task: TaskRecord;
}

/**
 * Overview tab — the default landing tab for a task. Two-column layout:
 *
 *   - Left: a "Summary" card. Renders `success.output` as markdown.
 *     Falls back to the first 1KB of `brief` or the failure message
 *     when `output` is null/empty, per the mission-A spec.
 *   - Right: the {@link DetailsSidebar} (label → value pairs from the
 *     existing TaskRecord ONLY — no Mission-B fields).
 */
export function OverviewTab({ task }: OverviewTabProps) {
  return (
    <div className="overview-tab">
      <section className="overview-tab__summary">
        <h3 className="overview-tab__section-title">Summary</h3>
        <SummaryBody task={task} />
      </section>
      <DetailsSidebar task={task} />
    </div>
  );
}

const FALLBACK_BRIEF_CHARS = 1024;

function SummaryBody({ task }: { task: TaskRecord }) {
  const output = typeof task.success?.output === "string" ? task.success.output.trim() : "";
  if (output.length > 0) {
    return <MarkdownSummary source={output} />;
  }
  // Failure / cancellation tasks have no `success.output` — surface
  // the failure message so the user sees something other than a
  // bare "(empty)".
  if (task.failure) {
    return (
      <div className="alert alert--error" style={{ margin: 0 }}>
        <strong>Failure:</strong> {task.failure.message}
      </div>
    );
  }
  if (task.cancellation) {
    return (
      <div className="alert alert--info" style={{ margin: 0 }}>
        {task.cancellation.message || "Task was cancelled."}
      </div>
    );
  }
  // Running / not-yet-completed: fall back to the brief.
  const briefSnippet =
    task.brief.length > FALLBACK_BRIEF_CHARS
      ? `${task.brief.slice(0, FALLBACK_BRIEF_CHARS)}…`
      : task.brief;
  return (
    <p className="muted" style={{ margin: 0 }}>
      {briefSnippet}
    </p>
  );
}

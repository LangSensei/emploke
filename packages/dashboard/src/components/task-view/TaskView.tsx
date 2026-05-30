import { useState } from "react";
import type { TaskActivity, TaskRecord } from "../../api";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";
import { StatusBadge } from "../tasks/StatusBadge";
import { readRuntime, STATUS_TONE } from "../tasks/shared";
import { ActivityTab } from "../tasks/TaskDetail/ActivityTab";
import { ArtifactsTab, countArtifacts } from "../tasks/TaskDetail/ArtifactsTab";
import { CopyButton } from "../tasks/TaskDetail/CopyButton";
import { OverviewTab } from "../tasks/TaskDetail/OverviewTab";

export interface TaskViewProps {
  /**
   * The task being shown. May be `null` while initial fetch is in flight.
   *
   * Truth source: when `task` is non-null, all UI (header title, status,
   * meta chips, copy-id, artifact counts, tab body) reads from `task.id`
   * / `task.*`. `requestedTaskId` is used only as a fallback display
   * string and as the reset key for activity stick-to-bottom behaviour
   * (so the visible task swap correctly resets the scroll/expand state).
   */
  task: TaskRecord | null;
  /**
   * The id that was requested from the data source. May not yet equal
   * `task?.id` during a swap. Used as the activity tab's reset key and
   * as the header fallback when `task` is still loading.
   */
  requestedTaskId: string;
  activity: TaskActivity | null;
  activityError: string | null;
  onLoadOlder: () => Promise<void>;
}

type DetailTab = "overview" | "activity" | "artifacts";

/**
 * Dumb presentational view of a single task — header (title + status +
 * meta + statbar), tab nav (Overview / Activity / Artifacts), and tab
 * body. All data comes in via props; no fetching, no URL state, no
 * navigation. Internal state is purely visual (active tab + title
 * clamp toggle).
 *
 * Layout contract (matters for parent CSS): returns a Fragment, NOT a
 * wrapper element. Callers MUST render `<TaskView/>` as a direct child
 * of `.tasks-pane__detail` (or a layout container that mimics its flex
 * behaviour) so the existing `.task-detail__head` / `.task-tabs` /
 * `.task-detail__body` direct-child selectors apply. Wrapping
 * `<TaskView/>` in an extra `<div>` breaks scroll/flex layout.
 *
 * Used by:
 *   - `tasks/TaskDetail.tsx` (Tasks page master-detail right pane)
 *   - `schedules/FireTaskDetailPane.tsx` (Schedules page Mode B; added
 *     in a follow-up PR)
 */
export function TaskView({
  task,
  requestedTaskId,
  activity,
  activityError,
  onLoadOlder,
}: TaskViewProps) {
  const [tab, setTab] = useState<DetailTab>("overview");

  const runtime = task ? readRuntime(task) : null;
  const isRunning = task?.status === "running";
  const artifactCount = countArtifacts(task);
  const title = task?.brief ?? requestedTaskId;

  return (
    <>
      <header className="task-detail__head">
        <div className="task-detail__title-row">
          <h2 className="task-detail__title" title={title}>
            {title}
          </h2>
        </div>

        {task && (
          <div className="task-detail__meta-row">
            <StatusBadge status={task.status} tone={STATUS_TONE[task.status]} pulse={!!isRunning} />
            <span className="task-detail__meta-chip">{task.agent}</span>
            {runtime && <span className="task-detail__meta-chip">{runtime}</span>}
          </div>
        )}

        {task && (
          <div className="task-detail__statbar">
            {task.startedAt && (task.endedAt || isRunning) && (
              <span
                title={
                  task.endedAt
                    ? `Ended ${formatAbsolute(task.endedAt)}`
                    : "Running, elapsed up to now"
                }
              >
                <span className="task-detail__statbar-key">Runtime</span>{" "}
                {formatDuration(task.startedAt, task.endedAt ?? null)}
              </span>
            )}
            {task.startedAt && (
              <span title={formatAbsolute(task.startedAt)}>
                <span className="task-detail__statbar-key">Started</span>{" "}
                {formatRelative(task.startedAt)}
              </span>
            )}
            {task.startedAt && (
              <span className="muted" title="Absolute start time">
                {formatAbsolute(task.startedAt)}
              </span>
            )}
            <span className="task-detail__statbar-id">
              <span className="task-detail__statbar-key">Task ID</span> <code>{task.id}</code>
              <CopyButton text={task.id} label="Copy task id" />
            </span>
          </div>
        )}
      </header>

      <nav className="task-tabs" aria-label="Task detail sections">
        <TabButton current={tab} value="overview" onSelect={setTab} label="Overview" />
        <TabButton current={tab} value="activity" onSelect={setTab} label="Activity" />
        <TabButton
          current={tab}
          value="artifacts"
          onSelect={setTab}
          label={`Artifacts (${artifactCount})`}
        />
      </nav>

      {!task && (
        <div className="task-detail__body">
          <p className="muted">Loading task…</p>
        </div>
      )}

      {task && tab === "overview" && (
        <OverviewTab task={task} activity={activity} onSwitchTab={setTab} />
      )}
      {task && tab === "activity" && (
        <ActivityTab
          taskId={task.id}
          activity={activity}
          activityError={activityError}
          onLoadOlder={onLoadOlder}
        />
      )}
      {task && tab === "artifacts" && <ArtifactsTab task={task} />}
    </>
  );
}

function TabButton({
  current,
  value,
  onSelect,
  label,
}: {
  current: DetailTab;
  value: DetailTab;
  onSelect: (v: DetailTab) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`task-tabs__btn${current === value ? " task-tabs__btn--active" : ""}`}
      onClick={() => onSelect(value)}
      aria-pressed={current === value}
    >
      {label}
    </button>
  );
}

import { useEffect, useState } from "react";
import type { TaskRecord } from "../../api";
import { useTaskDetail } from "../../hooks/useTaskDetail";
import { formatAbsolute, formatDuration, formatRelative } from "../../utils/time";
import { CloseIcon, RefreshIcon, StopIcon, TrashIcon } from "../Icons";
import { StatusBadge } from "./StatusBadge";
import { readRuntime, STATUS_TONE } from "./shared";
import { ActivityTab } from "./TaskDetail/ActivityTab";
import { ArtifactsTab, countArtifacts } from "./TaskDetail/ArtifactsTab";
import { CopyButton } from "./TaskDetail/DetailsSidebar";
import { OverviewTab } from "./TaskDetail/OverviewTab";

export interface TaskDetailProps {
  taskId: string;
  onClose: () => void;
  onCancel: (task: TaskRecord) => void;
  onRequestDelete: (task: TaskRecord) => void;
  pollIntervalMs: number;
}

type DetailTab = "overview" | "activity" | "artifacts";

/**
 * Right-column task detail panel for the master-detail Tasks page.
 *
 * Responsibilities:
 *   - Drive per-task data loading via {@link useTaskDetail} (poll +
 *     SSE + paginated activity merge).
 *   - Render the title + meta strip + action buttons (Refresh / Delete
 *     on terminal tasks; Cancel on running tasks). Per the mission-A
 *     spec, "Run again" and "Open PR" are intentionally absent — those
 *     are mission-B affordances.
 *   - Switch between the three tabs (Overview / Activity / Artifacts).
 */
export function TaskDetail({
  taskId,
  onClose,
  onCancel,
  onRequestDelete,
  pollIntervalMs,
}: TaskDetailProps) {
  const { task, activity, activityError, refresh, loadOlder } = useTaskDetail(
    taskId,
    pollIntervalMs,
  );
  const [tab, setTab] = useState<DetailTab>("overview");
  // F7: header title is clamped to 2 lines; clicking expands to the
  // full brief. Re-clamp whenever the visible task changes so a long
  // brief from a previous selection doesn't leak into the next one.
  const [titleExpanded, setTitleExpanded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: collapse on task swap; effect re-runs when taskId changes
  useEffect(() => {
    setTitleExpanded(false);
  }, [taskId]);

  const runtime = task ? readRuntime(task) : null;
  const isRunning = task?.status === "running";
  const artifactCount = countArtifacts(task);
  const title = task?.brief ?? taskId;

  return (
    <aside className="tasks-pane__detail">
      <header className="task-detail__head">
        {/* Mobile-only "Back to tasks" link. Hidden on desktop via CSS
            since the left list is permanent there. */}
        <button type="button" className="task-detail__back btn btn--ghost" onClick={onClose}>
          ← Back to tasks
        </button>

        <div className="task-detail__title-row">
          <button
            type="button"
            className={`task-detail__title-btn${titleExpanded ? " task-detail__title-btn--expanded" : ""}`}
            onClick={() => setTitleExpanded((v) => !v)}
            aria-expanded={titleExpanded}
            aria-label={titleExpanded ? "Collapse title" : "Expand title"}
            title={titleExpanded ? "Collapse" : title}
          >
            <h2
              className={`task-detail__title${
                titleExpanded ? " task-detail__title--expanded" : " task-detail__title--clamp"
              }`}
            >
              {title}
            </h2>
            <span className="task-detail__title-caret" aria-hidden="true">
              {titleExpanded ? "▾" : "▸"}
            </span>
          </button>
          <div className="task-detail__title-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void refresh()}
              title="Re-fetch this task"
              aria-label="Refresh task"
            >
              <RefreshIcon />
              <span>Refresh</span>
            </button>
            {task && !isRunning && (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => onRequestDelete(task)}
                title="Delete this task"
                aria-label={`Delete task ${task.brief}`}
              >
                <TrashIcon />
                <span>Delete</span>
              </button>
            )}
            {task && isRunning && (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => onCancel(task)}
                title="Send SIGTERM and mark cancelled"
                aria-label={`Cancel task ${task.brief}`}
              >
                <StopIcon />
                <span>Cancel</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--icon task-detail__close"
              onClick={onClose}
              aria-label="Close detail"
              title="Close"
            >
              <CloseIcon />
            </button>
          </div>
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
          taskId={taskId}
          activity={activity}
          activityError={activityError}
          onLoadOlder={loadOlder}
        />
      )}
      {task && tab === "artifacts" && <ArtifactsTab task={task} />}
    </aside>
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

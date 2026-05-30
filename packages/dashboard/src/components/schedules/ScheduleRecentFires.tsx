import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listScheduledTasks, type TaskRecord } from "../../api";
import { formatAbsolute, formatRelative } from "../../utils/time";
import { StatusBadge } from "../tasks/StatusBadge";
import { STATUS_TONE } from "../tasks/shared";

export interface ScheduleRecentFiresProps {
  /** Schedule id used to scope the `?scheduleId=` query. */
  scheduleId: string;
  /** UUID of the workspace currently in scope — used to build deep-link URLs. */
  currentWorkspaceId: string;
  /**
   * Bumps each time the parent wants to force a refresh (e.g. after
   * the user clicked "Run now" and a new running task was created on
   * the server side). Polling on top would be overkill for v1 — the
   * page already auto-refreshes on tab visibility.
   */
  refreshToken: number;
  /**
   * Callback fired when the user clicks a recent-fire row. The parent
   * page swaps the detail-pane into Mode B (the fire's task detail)
   * by writing `?fireTaskId=<id>` to the URL atomically with
   * `?scheduleId=`. Falls back to a deep-link to the Tasks page when
   * not provided (early-mount or out-of-tree consumers).
   */
  onSelectFire?: (taskId: string) => void;
}

const MAX_ROWS = 10;

/**
 * "Recent fires" panel rendered inside the schedule detail panel.
 * Lists the latest 10 schedule-launched tasks scoped to the current
 * schedule id; clicking a row swaps the right-pane into Mode B (the
 * fire's full task detail) by calling `onSelectFire` — no navigation,
 * the schedule list stays visible. When `onSelectFire` isn't wired
 * the row falls back to a deep-link into the Tasks page.
 */
export function ScheduleRecentFires({
  scheduleId,
  currentWorkspaceId,
  refreshToken,
  onSelectFire,
}: ScheduleRecentFiresProps) {
  const [rows, setRows] = useState<TaskRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is intentionally part of the re-fetch trigger set; parent bumps it after a run-now to surface the synthetic task row
  useEffect(() => {
    let cancelled = false;
    setError(null);
    listScheduledTasks({ scheduleId })
      .then((next) => {
        if (cancelled) return;
        next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRows(next.slice(0, MAX_ROWS));
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleId, refreshToken]);

  return (
    <section className="schedule-detail__recent" aria-label="Recent fires">
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 8px 0" }}>Recent fires</h3>
      {error && <div className="alert alert--error">⚠️ {error}</div>}
      {rows === null ? (
        <p className="muted" style={{ fontSize: 12 }}>
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          This schedule hasn't fired yet.
        </p>
      ) : (
        <ul className="task-list" style={{ borderTop: "1px solid var(--color-border)" }}>
          {rows.map((t) => (
            <li key={t.id}>
              <ScheduleFireRow
                task={t}
                currentWorkspaceId={currentWorkspaceId}
                onSelectFire={onSelectFire}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ScheduleFireRowProps {
  task: TaskRecord;
  currentWorkspaceId: string;
  onSelectFire?: (taskId: string) => void;
}

/**
 * Single recent-fire row. When `onSelectFire` is set the row is a
 * real `<button>` so keyboard and click semantics come for free; when
 * it isn't (early-mount or out-of-tree consumers) the row falls back
 * to a `<Link>` to the Tasks page so deep-linking still works.
 */
function ScheduleFireRow({ task, currentWorkspaceId, onSelectFire }: ScheduleFireRowProps) {
  const meta = (
    <>
      <div className="task-list__item-head">
        <StatusBadge
          status={task.status}
          tone={STATUS_TONE[task.status]}
          pulse={task.status === "running"}
        />
      </div>
      <div className="task-list__item-meta muted">
        <span title={formatAbsolute(task.createdAt)}>{formatRelative(task.createdAt)}</span>
      </div>
      <code className="task-list__id task-list__id--muted" title={task.id}>
        {task.id}
      </code>
    </>
  );

  if (onSelectFire) {
    return (
      <button
        type="button"
        className="task-list__item task-list__item--button"
        onClick={() => onSelectFire(task.id)}
        data-testid={`schedule-fire-row-${task.id}`}
        title="Open this fire's task detail"
      >
        {meta}
      </button>
    );
  }
  return (
    <Link
      to={`/workspaces/${encodeURIComponent(currentWorkspaceId)}/runtime/tasks?taskId=${encodeURIComponent(
        task.id,
      )}`}
      className="task-list__item task-list__item--button"
      data-testid={`schedule-fire-row-${task.id}`}
    >
      {meta}
    </Link>
  );
}

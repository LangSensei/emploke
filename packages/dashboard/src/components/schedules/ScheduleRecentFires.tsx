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
}

const MAX_ROWS = 10;

/**
 * "Recent fires" panel rendered inside the schedule detail panel.
 * Lists the latest 10 schedule-launched tasks scoped to the current
 * schedule id; each row drills into the Tasks page at
 * `?taskId=<id>` so users can read the full activity / artifacts
 * surface without leaving the dashboard.
 */
export function ScheduleRecentFires({
  scheduleId,
  currentWorkspaceId,
  refreshToken,
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
            <li key={t.id} className="task-list__item">
              <div className="task-list__item-head">
                <StatusBadge
                  status={t.status}
                  tone={STATUS_TONE[t.status]}
                  pulse={t.status === "running"}
                />
              </div>
              <div className="task-list__item-meta muted">
                <span title={formatAbsolute(t.createdAt)}>{formatRelative(t.createdAt)}</span>
                <span className="task-list__sep">·</span>
                <Link
                  to={`/workspaces/${encodeURIComponent(currentWorkspaceId)}/runtime/tasks?taskId=${encodeURIComponent(
                    t.id,
                  )}`}
                >
                  View task →
                </Link>
              </div>
              <code className="task-list__id task-list__id--muted" title={t.id}>
                {t.id}
              </code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

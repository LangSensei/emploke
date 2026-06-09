import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { SessionView, TaskRecord } from "../../api";
import { formatRelative } from "../../utils/time";

interface AgentOverviewTabProps {
  fqn: string;
  /**
   * Tasks for this agent. Lifted to {@link AgentDetailPage} so the
   * header status pill, the KPI tiles, and this tab share one source
   * of truth (Phase 1.5 §4.3 / Block I).
   *
   * `null` means "still loading"; we render the loading state until both
   * tasks and sessions resolve. `error` is also passed in from the parent
   * so a fetch failure surfaces here once.
   */
  tasks: TaskRecord[] | null;
  /** Sessions for this agent — lifted to the parent for the same reason as `tasks`. */
  sessions: SessionView[] | null;
  tasksError: string | null;
  sessionsError: string | null;
  /** Pre-built URLs for the global Sessions/Tasks pages with the agent filter pre-applied. */
  sessionsUrl: string;
  tasksUrl: string;
}

/**
 * Per-agent Overview — Phase 1.5 §4.4 / Block J. Replaced the previous
 * stacked-sections layout with a 2x2 grid:
 *
 *   ┌───────────────────────┬───────────────────────┐
 *   │ Recent tasks (top 5)  │ Active sessions       │
 *   │ View all tasks →      │ View all sessions →   │
 *   ├───────────────────────┼───────────────────────┤
 *   │ Current activity      │ (Capabilities cell    │
 *   │ (running … / Idle …)  │  omitted — no data    │
 *   │                       │  pipe yet, §4.4)      │
 *   └───────────────────────┴───────────────────────┘
 *
 * The "Capabilities" cell from the mockup is **omitted entirely** this
 * round — the catalog API exposes `agent.dependencies.skills`,
 * `agent.dependencies.mcps`, and `agent.dependencies.agents`, but those
 * are install metadata, not runtime capabilities the agent "speaks".
 * Surfacing them as "Capabilities" would conflate two unrelated
 * things. The grid degrades to 2x1 (Current activity spans the bottom
 * row) when the cell is absent.
 *
 * Empty-agent state (zero tasks + zero sessions) keeps the PR #189
 * polish-round single-`.empty` panel — applied **before** the grid so
 * the user sees one clear "nothing's happened" state instead of four
 * "no rows" cells.
 *
 * The View-all links navigate to the global Sessions / Tasks pages
 * with `?agent=<fqn>` pre-applied (the Phase 1.5 §4.5 / §4.6 contract
 * for the per-agent shortcut into the panoramic lists).
 */
export function AgentOverviewTab({
  fqn,
  tasks,
  sessions,
  tasksError,
  sessionsError,
  sessionsUrl,
  tasksUrl,
}: AgentOverviewTabProps) {
  const error = tasksError ?? sessionsError;
  // Compute the relative-time anchor for the "Idle since X" caption
  // up front (before any early return) so the hook order stays stable
  // across render paths. The memo computes safely against a null
  // tasks list — it just yields null.
  const sortedTasks = useMemo(
    () => (tasks === null ? [] : [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    [tasks],
  );
  const latestTaskUpdated = useMemo(() => {
    const ts: string[] = [];
    for (const t of sortedTasks) {
      const candidate = t.endedAt ?? t.startedAt ?? t.createdAt;
      if (candidate) ts.push(candidate);
    }
    if (ts.length === 0) return null;
    return ts.sort().at(-1) ?? null;
  }, [sortedTasks]);

  if (error) return <div className="alert alert--error">⚠️ {error}</div>;
  if (tasks === null || sessions === null) {
    return (
      <div className="empty">
        <p className="empty__title">Loading…</p>
      </div>
    );
  }

  const runningTask = sortedTasks.find((t) => t.status === "running") ?? null;
  const recentTasks = sortedTasks.slice(0, 5);
  const activeSessions = sessions.slice(0, 5);

  // Block E (PR #189 polish): when nothing has ever run for this
  // agent, collapse the grid into a single panel with a dispatch
  // CTA. Otherwise the page is just four mostly-empty cells which
  // reads as broken rather than as a clean empty state.
  const noActivity = sortedTasks.length === 0 && activeSessions.length === 0;
  if (noActivity) {
    return (
      <div className="empty" data-testid="agent-overview-empty">
        <div className="empty__icon" aria-hidden="true">
          ✨
        </div>
        <p className="empty__title">No activity yet</p>
        <p className="empty__hint">
          This agent hasn't run any tasks or sessions in this workspace.
        </p>
      </div>
    );
  }

  return (
    <div
      className="agent-overview agent-overview--grid"
      data-testid="agent-overview-grid"
      data-agent-fqn={fqn}
    >
      <section className="agent-overview__cell" data-testid="agent-overview-cell-tasks">
        <h3 className="agent-overview__heading">Recent tasks</h3>
        {recentTasks.length === 0 ? (
          <p className="muted">No tasks yet.</p>
        ) : (
          <ul className="agent-overview__list">
            {recentTasks.map((t) => (
              <li key={t.id} className="agent-overview__item">
                <Link
                  to={`${tasksUrl}&taskId=${encodeURIComponent(t.id)}`}
                  className="agent-overview__row"
                  aria-label={`Open task ${t.brief}`}
                >
                  <span className={`agent-overview__badge agent-overview__badge--${t.status}`}>
                    {t.status}
                  </span>
                  <span className="agent-overview__title">{t.brief}</span>
                  <span className="agent-overview__meta muted">{formatRelative(t.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link to={tasksUrl} className="agent-overview__more">
          View all tasks →
        </Link>
      </section>

      <section className="agent-overview__cell" data-testid="agent-overview-cell-sessions">
        <h3 className="agent-overview__heading">Active sessions</h3>
        {activeSessions.length === 0 ? (
          <p className="muted">No active sessions for this agent.</p>
        ) : (
          <ul className="agent-overview__list">
            {activeSessions.map((s) => (
              <li key={s.id} className="agent-overview__item">
                <Link
                  to={sessionsUrl}
                  state={{ preselectId: s.id }}
                  className="agent-overview__row"
                  aria-label={`Open session ${s.id}`}
                >
                  <code className="agent-overview__title">{s.id}</code>
                  <span className="agent-overview__meta muted">
                    {s.lastActiveAt ? formatRelative(s.lastActiveAt) : "never run"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link to={sessionsUrl} className="agent-overview__more">
          View all sessions →
        </Link>
      </section>

      <section
        className="agent-overview__cell agent-overview__cell--wide"
        data-testid="agent-overview-cell-activity"
      >
        <h3 className="agent-overview__heading">Current activity</h3>
        {runningTask !== null ? (
          <p className="agent-overview__activity">
            <span className="agent-overview__title">{runningTask.brief}</span>
            <span className="agent-overview__activity-dots" aria-hidden="true">
              <span className="agent-overview__activity-dot" />
              <span className="agent-overview__activity-dot" />
              <span className="agent-overview__activity-dot" />
            </span>
            <span className="muted">running for {formatRelative(runningTask.createdAt)}</span>
          </p>
        ) : (
          <p className="muted" data-testid="agent-overview-idle">
            Idle{latestTaskUpdated ? ` since ${formatRelative(latestTaskUpdated)}` : ""}
          </p>
        )}
      </section>
    </div>
  );
}

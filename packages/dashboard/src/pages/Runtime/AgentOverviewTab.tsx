import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listSessions, type SessionView, type TaskRecord } from "../../api";
import { formatRelative } from "../../utils/time";

interface AgentOverviewTabProps {
  fqn: string;
  /**
   * Tasks for this agent. Lifted to {@link AgentDetailPage} so the header
   * status pill and this tab share one source of truth (fix for review
   * round 1 — the pill used to be hard-coded "idle").
   *
   * `null` means "still loading"; we render the loading state until both
   * tasks and sessions resolve. `error` is also passed in from the parent
   * so a fetch failure surfaces here once.
   */
  tasks: TaskRecord[] | null;
  tasksError: string | null;
  /** Pre-built URLs for the three tabs so navigation stays type-safe. */
  overviewUrl: string;
  sessionsUrl: string;
  tasksUrl: string;
}

/**
 * Monitor-only dashboard for a single agent: running tasks, recent tasks,
 * recent sessions. No metrics / logs / resource sections — those were in
 * the mockup but explicitly out of scope (TASK.md and #agent-centric-ui).
 *
 * Tasks are fetched by {@link AgentDetailPage} and passed in so the
 * header status pill stays accurate on every sub-tab. Sessions are
 * still fetched here since they're only consumed by this tab.
 */
export function AgentOverviewTab({
  fqn,
  tasks,
  tasksError,
  sessionsUrl,
  tasksUrl,
}: AgentOverviewTabProps) {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setSessionsError(null);
    listSessions({ agent: fqn })
      .then((s) => {
        if (cancelled) return;
        s.sort((a, b) => {
          const al = a.lastActiveAt ?? a.createdAt;
          const bl = b.lastActiveAt ?? b.createdAt;
          return bl.localeCompare(al);
        });
        setSessions(s);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSessionsError(e instanceof Error ? e.message : String(e));
        setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fqn]);

  const error = tasksError ?? sessionsError;
  if (error) return <div className="alert alert--error">⚠️ {error}</div>;
  if (tasks === null || sessions === null) {
    return (
      <div className="empty">
        <p className="empty__title">Loading…</p>
      </div>
    );
  }

  const sortedTasks = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const running = sortedTasks.filter((t) => t.status === "running");
  const recentTasks = sortedTasks.slice(0, 5);
  const recentSessions = sessions.slice(0, 5);

  // Block E (PR #189 polish): when nothing has ever run for this agent,
  // collapse the three empty section headers into a single panel with a
  // dispatch CTA. Otherwise the page is just three "No ... yet" lines
  // stacked under each other, which reads as broken rather than as a
  // clean empty state.
  const noActivity = sortedTasks.length === 0 && recentSessions.length === 0;
  if (noActivity) {
    return (
      <div className="empty" data-testid="agent-overview-empty">
        <div className="empty__icon" aria-hidden="true">
          ✨
        </div>
        <p className="empty__title">No activity yet</p>
        <p className="empty__hint">
          This agent hasn't run any tasks or sessions in this workspace.{" "}
          <Link to={tasksUrl} className="agent-overview__more">
            Dispatch a task →
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="agent-overview">
      <section className="agent-overview__section">
        <h3 className="agent-overview__heading">Running tasks</h3>
        {running.length === 0 ? (
          <p className="muted">No tasks currently running for this agent.</p>
        ) : (
          <ul className="agent-overview__list">
            {running.map((t) => (
              <li key={t.id} className="agent-overview__item">
                <Link
                  to={tasksUrl}
                  state={{ preselectId: t.id }}
                  className="agent-overview__row"
                  aria-label={`Open task ${t.brief}`}
                >
                  <span className="agent-overview__badge agent-overview__badge--running">
                    running
                  </span>
                  <span className="agent-overview__title">{t.brief}</span>
                  <span className="agent-overview__meta muted">{formatRelative(t.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="agent-overview__section">
        <h3 className="agent-overview__heading">Recent tasks</h3>
        {recentTasks.length === 0 ? (
          <p className="muted">No tasks yet.</p>
        ) : (
          <ul className="agent-overview__list">
            {recentTasks.map((t) => (
              <li key={t.id} className="agent-overview__item">
                <Link
                  to={tasksUrl}
                  state={{ preselectId: t.id }}
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

      <section className="agent-overview__section">
        <h3 className="agent-overview__heading">Recent sessions</h3>
        {recentSessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <ul className="agent-overview__list">
            {recentSessions.map((s) => (
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
    </div>
  );
}

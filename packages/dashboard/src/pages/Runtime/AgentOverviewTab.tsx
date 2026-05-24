import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listSessions, listTasks, type SessionView, type TaskRecord } from "../../api";
import { formatRelative } from "../../utils/time";

interface AgentOverviewTabProps {
  fqn: string;
  /** Pre-built URLs for the three tabs so navigation stays type-safe. */
  overviewUrl: string;
  sessionsUrl: string;
  tasksUrl: string;
}

/**
 * Monitor-only dashboard for a single agent: running tasks, recent tasks,
 * recent sessions. No metrics / logs / resource sections — those were in
 * the mockup but explicitly out of scope (TASK.md and #agent-centric-ui).
 */
export function AgentOverviewTab({ fqn, sessionsUrl, tasksUrl }: AgentOverviewTabProps) {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTasks(null);
    setSessions(null);
    setError(null);
    Promise.all([listTasks({ agent: fqn, origin: "all" }), listSessions({ agent: fqn })])
      .then(([t, s]) => {
        if (cancelled) return;
        t.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        s.sort((a, b) => {
          const al = a.lastActiveAt ?? a.createdAt;
          const bl = b.lastActiveAt ?? b.createdAt;
          return bl.localeCompare(al);
        });
        setTasks(t);
        setSessions(s);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setTasks([]);
        setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fqn]);

  if (error) return <div className="alert alert--error">⚠️ {error}</div>;
  if (tasks === null || sessions === null) {
    return (
      <div className="empty">
        <p className="empty__title">Loading…</p>
      </div>
    );
  }

  const running = tasks.filter((t) => t.status === "running");
  const recentTasks = tasks.slice(0, 5);
  const recentSessions = sessions.slice(0, 5);

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
                <span className="agent-overview__badge agent-overview__badge--running">
                  running
                </span>
                <span className="agent-overview__title">{t.brief}</span>
                <span className="agent-overview__meta muted">{formatRelative(t.createdAt)}</span>
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
                <span className={`agent-overview__badge agent-overview__badge--${t.status}`}>
                  {t.status}
                </span>
                <span className="agent-overview__title">{t.brief}</span>
                <span className="agent-overview__meta muted">{formatRelative(t.createdAt)}</span>
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
                <code className="agent-overview__title">{s.id}</code>
                <span className="agent-overview__meta muted">
                  {s.lastActiveAt ? formatRelative(s.lastActiveAt) : "never run"}
                </span>
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

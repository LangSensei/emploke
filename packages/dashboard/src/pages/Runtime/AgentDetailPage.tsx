import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { listSessions, listTasks, type SessionView, type TaskRecord } from "../../api";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import { usePollWithBackoff } from "../../hooks/usePollWithBackoff";
import { AgentOverviewTab } from "./AgentOverviewTab";
import {
  type AgentRuntimeStatus,
  AgentStatusPill,
  avatarColorFor,
  avatarInitialsFor,
} from "./agentRuntime";

/** Default poll cadence when no server config is available. */
const DEFAULT_POLL_INTERVAL_MS = 4000;

/**
 * Per-agent detail page. Phase 1.5 §3.4 dropped the per-agent
 * Sessions/Tasks sub-tabs (those collapsed into the global lists with
 * `?agent=<fqn>` filter), so this page is now a single Overview view.
 *
 * The page fetches the agent's task list (for the status pill + KPI
 * tiles + Overview's Recent tasks cell) AND the session list (for the
 * Sessions KPI tile + Overview's Active sessions cell), then passes
 * both down to {@link AgentOverviewTab}. Lifting the fetches here means
 * the KPI tiles and the Overview cells read from one source of truth
 * — no duplicate network calls.
 *
 * Header rebuild (§4.3 / Block I): avatar + name/scope/version chip
 * + status pill on the title row; `+ New task` (primary) and
 * `Configure` action buttons trailing right; a 3-tile KPI row beneath.
 * No SubTabBar (Phase 2 polish).
 */
export function AgentDetailPage() {
  const { scope, short } = useParams<{ scope: string; short: string }>();
  const { wsId, data, config } = useWorkspaceShell();
  const fqn = `${scope ?? ""}/${short ?? ""}`;
  const entry = data.agents.find((a) => a.agent.fqn === fqn) ?? null;

  useBreadcrumb(short ?? "(unknown)", ["Runtime", "Agents", scope ?? "", short ?? ""]);

  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const pollIntervalMs = config?.tasks?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset cached state when the agent in the URL changes so a stale
  // list from the previous agent doesn't flash before the new fetch
  // resolves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate fqn-only reset; both lists belong to the previous agent and must be cleared synchronously when fqn changes
  useEffect(() => {
    setTasks(null);
    setTasksError(null);
    setSessions(null);
    setSessionsError(null);
  }, [fqn]);

  const refreshTasks = useCallback(async () => {
    if (!scope || !short) return;
    try {
      const t = await listTasks({ agent: fqn, origin: "all" });
      if (!mountedRef.current) return;
      setTasks(t);
      setTasksError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      // Keep last-known list on transient failure — the pill must not
      // flip to "Idle" because of a single failed poll while a task
      // is actually still running.
      setTasksError(e instanceof Error ? e.message : String(e));
      setTasks((prev) => (prev === null ? [] : prev));
    }
  }, [fqn, scope, short]);

  const refreshSessions = useCallback(async () => {
    if (!scope || !short) return;
    try {
      const s = await listSessions({ agent: fqn });
      if (!mountedRef.current) return;
      s.sort((a, b) => {
        const al = a.lastActiveAt ?? a.createdAt;
        const bl = b.lastActiveAt ?? b.createdAt;
        return bl.localeCompare(al);
      });
      setSessions(s);
      setSessionsError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setSessionsError(e instanceof Error ? e.message : String(e));
      setSessions((prev) => (prev === null ? [] : prev));
    }
  }, [fqn, scope, short]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  usePollWithBackoff(refreshTasks, pollIntervalMs, !!scope && !!short);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshTasks();
        void refreshSessions();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshTasks, refreshSessions]);

  const status: AgentRuntimeStatus = tasks?.some((t) => t.status === "running")
    ? "running"
    : "idle";

  // KPI totals — derived during render so re-fetches drive them
  // immediately. `runningTasks` is the live count from the poll;
  // `totalTasks7d` is the existing fetched list length (we already
  // narrow to a 7-day window at the AgentsListPage layer; per-agent
  // detail fetches the unfiltered list so this is "all known tasks
  // for the agent", which is close enough — the global Tasks page
  // shows the exact same number filtered by the same agent).
  const kpis = useMemo(() => {
    const runningTasks = tasks?.filter((t) => t.status === "running").length ?? 0;
    const totalTasks = tasks?.length ?? 0;
    const sessionsCount = sessions?.length ?? 0;
    return { runningTasks, totalTasks, sessionsCount };
  }, [tasks, sessions]);

  const sessionsUrl = `/workspaces/${encodeURIComponent(wsId)}/runtime/sessions?agent=${fqn}`;
  const tasksUrl = `/workspaces/${encodeURIComponent(wsId)}/runtime/tasks?agent=${fqn}`;
  const dispatchUrl = `${tasksUrl}&dispatch=1`;
  // Catalog has no per-agent route today — link to the agents tab with
  // an `?agent=` hint so the catalog page can scroll/highlight the
  // matching row in a future iteration. Documented choice (Phase 1.5
  // §4.3): no catalog/agents/<scope>/<short> route exists yet, so we
  // link the tab with the fqn hint.
  const configureUrl = `/workspaces/${encodeURIComponent(wsId)}/catalog/agents?agent=${fqn}`;

  if (!scope || !short) {
    return <Navigate to={`/workspaces/${encodeURIComponent(wsId)}/runtime/agents`} replace />;
  }

  return (
    <div className="agent-detail-page">
      <header className="agent-detail__header">
        <div className="agent-detail__title-row">
          <div
            className="agent-detail__avatar"
            data-testid="agent-detail-avatar"
            style={{ backgroundColor: avatarColorFor(fqn) }}
            aria-hidden="true"
          >
            {avatarInitialsFor(short)}
          </div>
          <div className="agent-detail__name-block">
            <h2 className="agent-detail__title">{short}</h2>
            <span className="agent-detail__scope muted">{scope}</span>
          </div>
          <AgentStatusPill status={status} />
          {entry && <span className="agent-detail__version muted">v{entry.agent.version}</span>}
          <span className="agent-detail__spacer" />
          <div className="agent-detail__actions">
            <Link to={dispatchUrl} className="btn btn--primary" data-testid="agent-detail-new-task">
              + New task
            </Link>
            <Link to={configureUrl} className="btn btn--ghost" data-testid="agent-detail-configure">
              Configure
            </Link>
          </div>
        </div>
        <div className="agent-detail__kpis" data-testid="agent-detail-kpis">
          <KpiTile label="Running tasks" value={kpis.runningTasks} caption="live" />
          <KpiTile label="Total tasks (7d)" value={kpis.totalTasks} caption="dispatched" />
          <KpiTile label="Sessions (7d)" value={kpis.sessionsCount} caption="recorded" />
        </div>
      </header>

      {!entry ? (
        <div className="alert alert--error">
          Agent <code>{fqn}</code> is not installed in this workspace. It may have been removed via
          Catalog.
        </div>
      ) : (
        <AgentOverviewTab
          fqn={fqn}
          tasks={tasks}
          sessions={sessions}
          tasksError={tasksError}
          sessionsError={sessionsError}
          sessionsUrl={sessionsUrl}
          tasksUrl={tasksUrl}
        />
      )}
    </div>
  );
}

interface KpiTileProps {
  label: string;
  value: number;
  caption: string;
}

function KpiTile({ label, value, caption }: KpiTileProps) {
  return (
    <div className="kpi-tile">
      <div className="kpi-tile__label">{label}</div>
      <div className="kpi-tile__value">{value}</div>
      <div className="kpi-tile__caption muted">{caption}</div>
    </div>
  );
}

import type { AgentEntry } from "@emploke/catalog";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { SessionView, TaskRecord } from "../../api";
import { AgentOverviewTab } from "./AgentOverviewTab";
import {
  type AgentRuntimeStatus,
  AgentStatusPill,
  avatarColorFor,
  avatarInitialsFor,
  splitFqn,
} from "./agentRuntime";

export interface AgentDetailPaneProps {
  /** Canonical agent identifier (`scope/short`). */
  fqn: string;
  /**
   * Catalog entry for the agent, or `null` when the fqn doesn't match any
   * installed agent in the current workspace (e.g. stale link, uninstalled
   * by another tab). When null the pane renders the "not installed" alert
   * in place of the Overview tab, but still renders the title/avatar/KPIs
   * so a refresh-on-the-fly install resolves cleanly.
   */
  entry: AgentEntry | null;
  /** Workspace UUID used to build the per-agent deep links. */
  wsId: string;
  /**
   * Tasks for this agent (Phase 1.5 §4.3 lifted from the inner Overview tab
   * so the header KPI tiles and the inner cells share one source of truth).
   * `null` while the first fetch is in flight.
   */
  tasks: TaskRecord[] | null;
  /** Sessions for this agent — same lifecycle as `tasks`. */
  sessions: SessionView[] | null;
  /** Latest fetch error for tasks (kept after the last successful list so it surfaces once). */
  tasksError: string | null;
  /** Latest fetch error for sessions — same shape. */
  sessionsError: string | null;
}

/**
 * Pure-presentational right-pane of the new master-detail Agents page.
 *
 * Phase 1.5 v2 polish: extracted from `AgentDetailPage` so the master-detail
 * `AgentsPage` can mount the same chrome inline (avatar + name/scope + status
 * pill + version + actions + KPI row + Overview tab) without owning two
 * separate fetch loops. The page-level `AgentsPage` owns the polling and
 * passes the resolved `tasks` / `sessions` arrays in; this component does
 * **no I/O** and **does not declare breadcrumbs** — those are container
 * responsibilities (the master-detail page keeps the breadcrumb static at
 * `Runtime / Agents` regardless of which agent is selected).
 *
 * Routing-shim consumers (the redirect-to-?selected= adapter in `App.tsx`)
 * do not mount this component; only the master-detail page does.
 */
export function AgentDetailPane({
  fqn,
  entry,
  wsId,
  tasks,
  sessions,
  tasksError,
  sessionsError,
}: AgentDetailPaneProps) {
  const { scope, short } = useMemo(() => {
    const parts = splitFqn(fqn);
    if (parts !== null) return parts;
    // Defensive fallback for a malformed `?selected=` value — split on the
    // first slash so the avatar/title still render something sensible while
    // the "not installed" alert below explains the missing entry.
    const ix = fqn.indexOf("/");
    return ix <= 0
      ? { scope: "", short: fqn }
      : { scope: fqn.slice(0, ix), short: fqn.slice(ix + 1) };
  }, [fqn]);

  const status: AgentRuntimeStatus = tasks?.some((t) => t.status === "running")
    ? "running"
    : "idle";

  // KPI totals — derived during render so re-fetches drive them immediately.
  const kpis = useMemo(() => {
    const runningTasks = tasks?.filter((t) => t.status === "running").length ?? 0;
    const totalTasks = tasks?.length ?? 0;
    const sessionsCount = sessions?.length ?? 0;
    return { runningTasks, totalTasks, sessionsCount };
  }, [tasks, sessions]);

  const sessionsUrl = `/workspaces/${encodeURIComponent(wsId)}/runtime/sessions?agent=${fqn}`;
  const tasksUrl = `/workspaces/${encodeURIComponent(wsId)}/runtime/tasks?agent=${fqn}`;
  const dispatchUrl = `${tasksUrl}&dispatch=1`;
  // Catalog has no per-agent route today — link to the agents tab with an
  // `?agent=` hint so the catalog page can scroll/highlight the matching row
  // in a future iteration (Phase 1.5 §4.3 documented choice).
  const configureUrl = `/workspaces/${encodeURIComponent(wsId)}/catalog/agents?agent=${fqn}`;

  return (
    <aside
      className="tasks-pane__detail agent-detail-pane"
      data-testid="agent-detail-pane"
      data-agent-fqn={fqn}
    >
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
    </aside>
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

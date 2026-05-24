import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listTasks, type TaskRecord } from "../../api";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import {
  type AgentRuntimeView,
  AgentStatusPill,
  agentDetailUrl,
  computeAgentRuntimeViews,
} from "./agentRuntime";

/**
 * Monitor-only list of every installed agent in the workspace, with a
 * live status pill computed by cross-referencing the catalog response
 * with the running-task list. There are no actions on this page (no
 * dispatch, no install, no uninstall) — those are explicit decisions
 * locked in #agent-centric-ui §3 and pushed to Catalog / per-agent
 * Tasks tab respectively.
 */
export function AgentsListPage() {
  const { wsId, data } = useWorkspaceShell();
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useBreadcrumb("Runtime", ["Runtime", "Agents"]);

  useEffect(() => {
    let cancelled = false;
    // 7-day window matches the default surface the Tasks tab uses; the
    // count shown in each row is "M total tasks (7d)" so we narrow at
    // the same horizon to keep the numbers consistent.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    listTasks({ createdSince: since, origin: "all" })
      .then((next) => {
        if (!cancelled) setTasks(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setTasks([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const views: AgentRuntimeView[] =
    tasks === null ? [] : computeAgentRuntimeViews(data.agents, tasks);

  return (
    <div className="agents-list-page">
      {error && <div className="alert alert--error">⚠️ {error}</div>}
      {tasks === null ? (
        <div className="empty">
          <p className="empty__title">Loading agents…</p>
        </div>
      ) : data.agents.length === 0 ? (
        <div className="empty">
          <p className="empty__title">No agents installed</p>
          <p className="empty__hint">
            Visit <Link to={`/workspaces/${encodeURIComponent(wsId)}/catalog/agents`}>Catalog</Link>{" "}
            to install agents.
          </p>
        </div>
      ) : (
        <ul className="agents-list" aria-label="Installed agents">
          {views.map((v) => (
            <AgentRow key={v.entry.agent.fqn} wsId={wsId} view={v} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface AgentRowProps {
  wsId: string;
  view: AgentRuntimeView;
}

function AgentRow({ wsId, view }: AgentRowProps) {
  const { agent } = view.entry;
  const [scope, short] = splitForDisplay(agent.fqn);
  const to = agentDetailUrl(wsId, scope, short, "overview");
  return (
    <li className="agents-list__item">
      <Link to={to} className="agents-list__link">
        <div className="agents-list__head">
          <span className="agents-list__name">{short}</span>
          <span className="agents-list__scope">{scope}</span>
          <span className="agents-list__spacer" />
          <AgentStatusPill status={view.status} />
        </div>
        <div className="agents-list__meta muted">
          <span>{view.runningTasks} running</span>
          <span className="agents-list__sep">·</span>
          <span>{view.totalTasks7d} total tasks (7d)</span>
          <span className="agents-list__sep">·</span>
          <span>v{agent.version}</span>
        </div>
      </Link>
    </li>
  );
}

function splitForDisplay(fqn: string): [string, string] {
  const ix = fqn.indexOf("/");
  if (ix <= 0) return ["", fqn];
  return [fqn.slice(0, ix), fqn.slice(ix + 1)];
}

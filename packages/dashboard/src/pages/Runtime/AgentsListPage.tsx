import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listTasks, type TaskRecord } from "../../api";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import { usePollWithBackoff } from "../../hooks/usePollWithBackoff";
import {
  type AgentRuntimeView,
  AgentStatusPill,
  agentDetailUrl,
  computeAgentRuntimeViews,
  splitFqn,
} from "./agentRuntime";

/** Default poll cadence when no server config is available. Matches
 *  `DEFAULT_POLL_INTERVAL_MS` in `pages/Tasks.tsx`. */
const DEFAULT_POLL_INTERVAL_MS = 4000;

/**
 * Monitor-only list of every installed agent in the workspace, with a
 * live status pill computed by cross-referencing the catalog response
 * with the running-task list. There are no actions on this page (no
 * dispatch, no install, no uninstall) — those are explicit decisions
 * locked in #agent-centric-ui §3 and pushed to Catalog / per-agent
 * Tasks tab respectively.
 *
 * The task list is polled via {@link usePollWithBackoff} so the status
 * pills and per-row counts stay live (PR #189 review round 3 — pills
 * used to freeze at mount). The hook re-uses the same cadence as the
 * Tasks page (config.tasks.pollIntervalMs, default 4s) and applies the
 * shared exponential-backoff-on-failure behaviour.
 */
export function AgentsListPage() {
  const { wsId, data, config } = useWorkspaceShell();
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useBreadcrumb("Runtime", ["Runtime", "Agents"]);

  const pollIntervalMs = config?.tasks?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const refresh = useCallback(async () => {
    // 7-day window matches the default surface the Tasks tab uses; the
    // count shown in each row is "M total tasks (7d)" so we narrow at
    // the same horizon to keep the numbers consistent.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    try {
      const next = await listTasks({ createdSince: since, origin: "all" });
      if (!mountedRef.current) return;
      setTasks(next);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      // Keep last-known list on transient failure — don't flip pills
      // to "Idle" or empty the screen because of one bad poll.
      setError(e instanceof Error ? e.message : String(e));
      setTasks((prev) => (prev === null ? [] : prev));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePollWithBackoff(refresh, pollIntervalMs, true);

  // Refresh immediately when the tab becomes visible again so users
  // coming back after hours don't see stale pills. Mirrors useTasks.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

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
          <div className="empty__icon" aria-hidden="true">
            🤖
          </div>
          <p className="empty__title">No agents installed</p>
          <p className="empty__hint">
            Visit{" "}
            <Link to={`/workspaces/${encodeURIComponent(wsId)}/catalog/agents`}>Catalog</Link> to
            install agents into this workspace.
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

/**
 * Display-side split of an agent fqn. Delegates to the canonical
 * {@link splitFqn} helper (review round 3, suggestion #3) and falls
 * back to a best-effort split for the rare case where an unusual fqn
 * sneaks through the catalog — keeping the row renderable rather than
 * crashing.
 */
function splitForDisplay(fqn: string): [string, string] {
  const parts = splitFqn(fqn);
  if (parts !== null) return [parts.scope, parts.short];
  const ix = fqn.indexOf("/");
  if (ix <= 0) return ["", fqn];
  return [fqn.slice(0, ix), fqn.slice(ix + 1)];
}

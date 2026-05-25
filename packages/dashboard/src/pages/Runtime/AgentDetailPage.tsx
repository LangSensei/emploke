import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { listTasks, type TaskRecord } from "../../api";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import { usePollWithBackoff } from "../../hooks/usePollWithBackoff";
import { SessionsPage } from "../Sessions";
import { TasksPage } from "../Tasks";
import { AgentOverviewTab } from "./AgentOverviewTab";
import {
  type AgentRuntimeStatus,
  AgentStatusPill,
  AgentSubTabBar,
  agentDetailUrl,
} from "./agentRuntime";

export type AgentDetailTab = "overview" | "sessions" | "tasks";

interface AgentDetailPageProps {
  tab: AgentDetailTab;
}

/** Default poll cadence when no server config is available. Matches
 *  `DEFAULT_POLL_INTERVAL_MS` in `pages/Tasks.tsx`. */
const DEFAULT_POLL_INTERVAL_MS = 4000;

/**
 * Per-agent detail page that hosts three sub-tabs (Overview / Sessions /
 * Tasks). The active tab is a real URL segment (`#agent-centric-ui §4`),
 * so browser back/forward navigates between tabs and a shared link drops
 * the recipient on the same view.
 *
 * The page reads the agent fqn from two path segments (`:scope/:short`)
 * rather than a percent-encoded slash — a deliberate readability call
 * documented in the design.
 *
 * The page polls this agent's task list via {@link usePollWithBackoff}
 * so the header status pill stays accurate while the user sits on
 * Sessions or Tasks (PR #189 review round 3 — pill used to freeze at
 * mount). The same task list is passed down to {@link AgentOverviewTab}
 * to avoid a duplicate fetch.
 */
export function AgentDetailPage({ tab }: AgentDetailPageProps) {
  const { scope, short } = useParams<{ scope: string; short: string }>();
  const { wsId, data, config, workspaces } = useWorkspaceShell();
  const fqn = `${scope ?? ""}/${short ?? ""}`;
  const entry = data.agents.find((a) => a.agent.fqn === fqn) ?? null;

  const tabLabel = tab === "overview" ? "Overview" : tab === "sessions" ? "Sessions" : "Tasks";
  useBreadcrumb(short ?? "(unknown)", ["Runtime", "Agents", scope ?? "", short ?? "", tabLabel]);

  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate fqn-only reset; tasks state belongs to the previous agent and must be cleared synchronously when fqn changes
  useEffect(() => {
    setTasks(null);
    setTasksError(null);
  }, [fqn]);

  const refresh = useCallback(async () => {
    if (!scope || !short) return;
    try {
      const t = await listTasks({ agent: fqn, origin: "all" });
      if (!mountedRef.current) return;
      setTasks(t);
      setTasksError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      // Keep last-known list on transient failure — the pill must not
      // flip to "Idle" because of a single failed poll while a task is
      // actually still running.
      setTasksError(e instanceof Error ? e.message : String(e));
      setTasks((prev) => (prev === null ? [] : prev));
    }
  }, [fqn, scope, short]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePollWithBackoff(refresh, pollIntervalMs, !!scope && !!short);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  // Pill stays "idle" while loading (matches the original conservative
  // default) and reflects real ≥1-running-task signal once data lands.
  // Per design §7, "Running" = at least one task with status === "running".
  const status: AgentRuntimeStatus =
    tasks && tasks.some((t) => t.status === "running") ? "running" : "idle";

  if (!scope || !short) {
    return <Navigate to={`/workspaces/${encodeURIComponent(wsId)}/runtime/agents`} replace />;
  }

  return (
    <div className="agent-detail-page">
      <header className="agent-detail__header">
        <div className="agent-detail__title-block">
          <h2 className="agent-detail__title">{short}</h2>
          <span className="agent-detail__scope muted">{scope}</span>
          {entry && <span className="agent-detail__version muted">v{entry.agent.version}</span>}
          <span className="agent-detail__spacer" />
          <AgentStatusPill status={status} />
        </div>
        <AgentSubTabBar wsId={wsId} scope={scope} short={short} active={tab} />
      </header>

      {!entry ? (
        <div className="alert alert--error">
          Agent <code>{fqn}</code> is not installed in this workspace. It may have been removed via
          Catalog.
        </div>
      ) : tab === "overview" ? (
        <AgentOverviewTab
          fqn={fqn}
          tasks={tasks}
          tasksError={tasksError}
          overviewUrl={agentDetailUrl(wsId, scope, short, "overview")}
          sessionsUrl={agentDetailUrl(wsId, scope, short, "sessions")}
          tasksUrl={agentDetailUrl(wsId, scope, short, "tasks")}
        />
      ) : tab === "sessions" ? (
        <SessionsPage
          agents={data.agents}
          config={config}
          currentWorkspaceId={wsId}
          workspaces={workspaces ?? []}
          fixedAgentFqn={fqn}
        />
      ) : (
        <TasksPage
          agents={data.agents}
          currentWorkspaceId={wsId}
          config={config}
          fixedAgentFqn={fqn}
        />
      )}
    </div>
  );
}

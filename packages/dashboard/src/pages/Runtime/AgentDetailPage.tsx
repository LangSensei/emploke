import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { listSessions, listTasks, type SessionView, type TaskRecord } from "../../api";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import { usePollWithBackoff } from "../../hooks/usePollWithBackoff";
import { AgentDetailPane } from "./AgentDetailPane";

/** Default poll cadence when no server config is available. */
const DEFAULT_POLL_INTERVAL_MS = 4000;

/**
 * Per-agent detail page (legacy standalone route). Phase 1.5 §3.4 dropped the
 * per-agent Sessions/Tasks sub-tabs, so this page is a single Overview view.
 *
 * Phase 1.5 v2 polish: the rendering body moved to {@link AgentDetailPane}
 * so the new master-detail `AgentsPage` can mount the same chrome inline.
 * This component now exists purely as the route adapter for the legacy URL
 * `/runtime/agents/:scope/:short/overview` — it fetches the per-agent
 * task/session lists, polls, and renders the pane. The agents-page-side
 * redirect that points new URLs at the master-detail page lives in
 * `App.tsx`; this page keeps working for old bookmarks while the redirect
 * is in place, and continues to update the breadcrumb deeper into the
 * agent name for parity with the pre-master-detail UI.
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

  // Reset cached state when the agent in the URL changes so a stale list
  // from the previous agent doesn't flash before the new fetch resolves.
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
      // Keep last-known list on transient failure — the pill must not flip
      // to "Idle" because of a single failed poll while a task is still
      // actually running.
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

  if (!scope || !short) {
    return <Navigate to={`/workspaces/${encodeURIComponent(wsId)}/runtime/agents`} replace />;
  }

  // The page wraps the pane in `.agent-detail-page` so the legacy standalone
  // layout (page padding + vertical stack) still applies; the pane carries
  // the master-detail-friendly `.tasks-pane__detail` styling that becomes a
  // no-op outside of `.tasks-pane`.
  return (
    <div className="agent-detail-page agent-detail-page--legacy">
      <AgentDetailPane
        fqn={fqn}
        entry={entry}
        wsId={wsId}
        tasks={tasks}
        sessions={sessions}
        tasksError={tasksError}
        sessionsError={sessionsError}
      />
    </div>
  );
}

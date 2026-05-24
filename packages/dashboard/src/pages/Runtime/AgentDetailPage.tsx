import { Navigate, useParams } from "react-router-dom";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import { SessionsPage } from "../Sessions";
import { TasksPage } from "../Tasks";
import { AgentOverviewTab } from "./AgentOverviewTab";
import { AgentStatusPill, AgentSubTabBar, agentDetailUrl } from "./agentRuntime";

export type AgentDetailTab = "overview" | "sessions" | "tasks";

interface AgentDetailPageProps {
  tab: AgentDetailTab;
}

/**
 * Per-agent detail page that hosts three sub-tabs (Overview / Sessions /
 * Tasks). The active tab is a real URL segment (`#agent-centric-ui §4`),
 * so browser back/forward navigates between tabs and a shared link drops
 * the recipient on the same view.
 *
 * The page reads the agent fqn from two path segments (`:scope/:short`)
 * rather than a percent-encoded slash — a deliberate readability call
 * documented in the design.
 */
export function AgentDetailPage({ tab }: AgentDetailPageProps) {
  const { scope, short } = useParams<{ scope: string; short: string }>();
  const { wsId, data, config, workspaces } = useWorkspaceShell();
  const fqn = `${scope ?? ""}/${short ?? ""}`;
  const entry = data.agents.find((a) => a.agent.fqn === fqn) ?? null;

  const tabLabel = tab === "overview" ? "Overview" : tab === "sessions" ? "Sessions" : "Tasks";
  useBreadcrumb(short ?? "(unknown)", ["Runtime", "Agents", scope ?? "", short ?? "", tabLabel]);

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
          {/* The list page already computes status, but mounting the detail
              page directly (deep link, refresh) needs an inline cue too.
              We render the Idle pill conservatively when we have no
              running-task signal yet — the Overview tab refines it as it
              fetches. */}
          <AgentStatusPill status="idle" />
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

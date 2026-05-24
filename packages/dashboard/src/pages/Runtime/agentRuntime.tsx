import type { AgentEntry } from "@emploke/catalog";
import { Link } from "react-router-dom";
import type { TaskRecord } from "../../api";

export type AgentRuntimeStatus = "running" | "idle";

export interface AgentRuntimeView {
  entry: AgentEntry;
  runningTasks: number;
  totalTasks7d: number;
  status: AgentRuntimeStatus;
}

/**
 * Cross-reference the catalog agent list with the (already-fetched) task
 * list to compute per-agent live status. Pure helper — no I/O — so it
 * can be exercised under vitest without mocking fetch.
 */
export function computeAgentRuntimeViews(
  agents: readonly AgentEntry[],
  tasks: readonly TaskRecord[],
): AgentRuntimeView[] {
  const runningByFqn = new Map<string, number>();
  const totalByFqn = new Map<string, number>();
  for (const t of tasks) {
    totalByFqn.set(t.agent, (totalByFqn.get(t.agent) ?? 0) + 1);
    if (t.status === "running") {
      runningByFqn.set(t.agent, (runningByFqn.get(t.agent) ?? 0) + 1);
    }
  }
  return agents.map((entry) => {
    const fqn = entry.agent.fqn;
    const runningTasks = runningByFqn.get(fqn) ?? 0;
    return {
      entry,
      runningTasks,
      totalTasks7d: totalByFqn.get(fqn) ?? 0,
      status: runningTasks > 0 ? "running" : "idle",
    };
  });
}

/**
 * Build the per-agent detail URL. Slashes inside the fqn are encoded by
 * keeping scope and short as two distinct path segments (#agent-centric-ui
 * §2) so the URL stays readable instead of carrying a percent-encoded `%2F`.
 */
export function agentDetailUrl(
  wsId: string,
  scope: string,
  short: string,
  tab: "overview" | "sessions" | "tasks" = "overview",
): string {
  return `/workspaces/${encodeURIComponent(wsId)}/runtime/agents/${encodeURIComponent(
    scope,
  )}/${encodeURIComponent(short)}/${tab}`;
}

/**
 * Split an agent fqn (`scope/short`) into its two parts. Returns null
 * for malformed input (no slash, or extra slashes) so callers can
 * decide whether to render an "unknown agent" placeholder.
 */
export function splitFqn(fqn: string): { scope: string; short: string } | null {
  const ix = fqn.indexOf("/");
  if (ix <= 0 || ix !== fqn.lastIndexOf("/")) return null;
  return { scope: fqn.slice(0, ix), short: fqn.slice(ix + 1) };
}

interface StatusPillProps {
  status: AgentRuntimeStatus;
}

export function AgentStatusPill({ status }: StatusPillProps) {
  return (
    <span className={`agent-status-pill agent-status-pill--${status}`} role="status">
      <span className="agent-status-pill__dot" aria-hidden="true" />
      <span className="agent-status-pill__label">{status === "running" ? "Running" : "Idle"}</span>
    </span>
  );
}

interface SubTabBarProps {
  wsId: string;
  scope: string;
  short: string;
  active: "overview" | "sessions" | "tasks";
}

export function AgentSubTabBar({ wsId, scope, short, active }: SubTabBarProps) {
  const tabs: ReadonlyArray<{ id: "overview" | "sessions" | "tasks"; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "sessions", label: "Sessions" },
    { id: "tasks", label: "Tasks" },
  ];
  return (
    <nav className="agent-subtabs" aria-label="Agent sub-navigation">
      {tabs.map((t) => (
        <Link
          key={t.id}
          to={agentDetailUrl(wsId, scope, short, t.id)}
          className={`agent-subtabs__tab${active === t.id ? " agent-subtabs__tab--active" : ""}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

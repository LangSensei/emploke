import type { AgentEntry } from "@emploke/catalog";
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
 * Build the per-agent detail URL. PR #189 polish v2 (master-detail split):
 * the canonical detail URL is now `/runtime/agents?selected=<scope>/<short>`
 * — selection lives in a URL query slot on the master Agents page, not in
 * a separate route. New code emits this shape directly so deep-links open
 * the master-detail page with the agent pre-selected.
 *
 * Backward compatibility: the old standalone routes
 * (`/runtime/agents/<scope>/<short>` and …/overview) still resolve via a
 * redirect adapter in `App.tsx`, so external bookmarks and PR-description
 * links stay valid mid-deploy. The `scope` and `short` halves are kept as
 * one slash-separated `?selected=` value (un-encoded slash for
 * readability; only the wsId and the fqn payload are encoded).
 */
export function agentDetailUrl(wsId: string, scope: string, short: string): string {
  const fqn = `${scope}/${short}`;
  return `/workspaces/${encodeURIComponent(wsId)}/runtime/agents?selected=${encodeURIComponent(fqn)}`;
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

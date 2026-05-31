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

/**
 * Phase G2 (TN-B F1-4): `splitFqn` used to live here as a fourth
 * dashboard-side reinvention. The canonical helper lives at
 * `src/utils/fqn.ts` (strict variant delegates to `@emploke/catalog`'s
 * `splitFqn`; the display variant has the never-throw fallback).
 * Callers import from there directly.
 */

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

/**
 * Phase 1.5 §3.4 / Block I — the per-agent SubTabBar (Overview / Sessions
 * / Tasks) is replaced by a single Overview view. The companion
 * Sessions/Tasks pages with `?agent=<fqn>` carry the per-agent shortcut
 * via the Overview "View all" links; the SubTabBar export was removed to
 * eliminate dead chrome.
 *
 * PR #189 polish v3 — the avatar helpers that lived here
 * (`avatarColorFor`, `avatarInitialsFor`) were retired in favour of the
 * shared {@link components/agents/AgentAvatar} component. The new
 * primitive's contract differs (8-colour hex palette, full-FQN hash,
 * monogram rule documented inline), so it's not a like-for-like move;
 * callers migrate by replacing inline `<div .agent-detail__avatar>`
 * markup with `<AgentAvatar fqn={fqn} label={short} size="…" />`.
 */

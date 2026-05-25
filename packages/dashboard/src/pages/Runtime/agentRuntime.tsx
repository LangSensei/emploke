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
 * Build the per-agent detail URL. Slashes inside the fqn are encoded by
 * keeping scope and short as two distinct path segments (#agent-centric-ui
 * §2) so the URL stays readable instead of carrying a percent-encoded `%2F`.
 *
 * Phase 1.5 §3.4 — Overview is the **default and only** sub-tab this round,
 * so the `tab` suffix dropped from the signature. The function emits the
 * `…/overview` path so the SPA's tab-aware route still matches.
 */
export function agentDetailUrl(wsId: string, scope: string, short: string): string {
  return `/workspaces/${encodeURIComponent(wsId)}/runtime/agents/${encodeURIComponent(
    scope,
  )}/${encodeURIComponent(short)}/overview`;
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

/**
 * Phase 1.5 §3.4 / Block I — the per-agent SubTabBar (Overview / Sessions
 * / Tasks) is replaced by a single Overview view. The companion
 * Sessions/Tasks pages with `?agent=<fqn>` carry the per-agent shortcut
 * via the Overview "View all" links; the SubTabBar export was removed to
 * eliminate dead chrome.
 *
 * The deterministic avatar palette and helper used by the new header live
 * here so both the header and the agents-list rows can share it (Phase 2
 * polish target: surface the avatar in the agents-list rows too).
 */
const AVATAR_PALETTE: ReadonlyArray<string> = [
  "var(--color-accent)",
  "var(--color-success)",
  "var(--color-warn)",
  "var(--color-danger)",
  "var(--color-accent-hover)",
];

/**
 * Deterministic accent-colour pick for an agent avatar. Hash-mod the
 * fqn through the existing accent palette (C4 — no new tokens this
 * round). Same fqn always yields the same colour across renders /
 * sessions / clients so the avatar acts as a stable visual id.
 */
export function avatarColorFor(fqn: string): string {
  let h = 0;
  for (let i = 0; i < fqn.length; i++) {
    h = (h * 31 + fqn.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/**
 * Two-letter avatar initials drawn from the agent's short name. Strips
 * the leading scope/separator before slicing so `emploke/dev-writer`
 * yields `DE` not `EM`. Up to 2 alphanumeric characters, upper-cased;
 * falls back to "??" if the short is empty (malformed fqn).
 */
export function avatarInitialsFor(short: string): string {
  const alphanum = short.replace(/[^a-zA-Z0-9]/g, "");
  if (alphanum.length === 0) return "??";
  return alphanum.slice(0, 2).toUpperCase();
}

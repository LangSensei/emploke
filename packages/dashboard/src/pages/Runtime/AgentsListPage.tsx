import type { AgentEntry } from "@emploke/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listSessions, listTasks, type SessionView, type TaskRecord } from "../../api";
import { AgentAvatar } from "../../components/agents/AgentAvatar";
import { AgentFqn } from "../../components/agents/AgentFqn";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import { usePollWithBackoff } from "../../hooks/usePollWithBackoff";
import { useUrlSearchValue } from "../../hooks/useUrlState";
import { AgentDetailPane } from "./AgentDetailPane";
import {
  type AgentRuntimeView,
  AgentStatusPill,
  computeAgentRuntimeViews,
  splitFqn,
} from "./agentRuntime";

const DEFAULT_POLL_INTERVAL_MS = 4000;

/**
 * `?filter=` URL slot values (Phase 1.5 §4.2 / Block H). `all` is the
 * default; `active` narrows to agents currently running ≥ 1 task; `idle`
 * is the complement.
 */
type ListFilter = "all" | "active" | "idle";
const LIST_FILTER_TABS: ReadonlyArray<{ value: ListFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "idle", label: "Idle" },
];

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Master-detail Agents page (PR #189 polish v2 → v3). Left pane: status
 * filter pills + search + scrollable list of installed agents with live
 * status pills and per-row avatars. Right pane: {@link AgentDetailPane}
 * mounted inline against the currently-selected agent (URL state
 * `?selected=<scope>/<short>`), or a placeholder when nothing is selected.
 *
 * Mirrors `pages/Tasks.tsx` (the layout reference). Page-level concerns:
 *
 *   - Selection lives in the URL via `useUrlSearchValue("selected", "")`.
 *     `?selected=` is intentionally **not** `?agent=` — the latter is the
 *     filter-by-agent key on `/runtime/tasks` and `/runtime/sessions`, and
 *     overloading the two across pages would silently corrupt filter
 *     state when the user navigates between them.
 *   - The auto-select-first-row fallback is derived **during render** via
 *     `useMemo` (Phase 1.5 Block G), not via `useEffect`. An effect-driven
 *     fallback re-introduces stale filter params after Clear-filters
 *     because it closes over the pre-clear state.
 *   - The page owns BOTH fetches:
 *       * `listTasks({ createdSince: 7d, origin: "all" })` for the left
 *         list's per-row status pills AND the right pane's KPI tiles +
 *         Overview-tab activity cells (filtered down to the selected fqn).
 *         One workspace-wide poll feeds both panes — no duplicate network
 *         calls.
 *       * `listSessions({ agent: <selectedFqn> })` only when something is
 *         selected; the per-agent session fetch stops when selection
 *         clears.
 *   - The breadcrumb stays **`Runtime / Agents`** regardless of which
 *     agent is selected (the right pane doesn't push a deeper crumb the
 *     way the legacy `/runtime/agents/<scope>/<short>/overview` route
 *     did). Users want the top nav stable as they hop between agents.
 *
 * PR #189 polish v3 anti-gating:
 *   - `computeAgentRuntimeViews(data.agents, tasks ?? [])` so the left
 *     list renders rows immediately from the shell-preloaded
 *     `data.agents`. The tasks fetch only feeds the per-row "running"
 *     tag (skeleton via `runtimeLoading` until it resolves) and the
 *     right-pane KPI / Recent-tasks regions.
 *   - `effectiveSelectedFqn` drops the `tasks !== null` precondition;
 *     auto-select fires on the first render with `data.agents`. URL
 *     selection still wins; a stale `?selected=` against an
 *     uninstalled agent still surfaces the "not installed" alert via
 *     the detail pane (v2 §10 divergence — intentional).
 */
export function AgentsListPage() {
  const { wsId, data, config } = useWorkspaceShell();
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useBreadcrumb("Runtime", ["Runtime", "Agents"]);

  const pollIntervalMs = config?.tasks?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // URL-driven filter state — `?filter=` for the status tab and `?q=` for
  // the search box. The search input also keeps a 200ms debounced local
  // mirror so each keystroke doesn't replace a history entry.
  const [listFilterRaw, setListFilterRaw] = useUrlSearchValue("filter", "all");
  const listFilter: ListFilter =
    listFilterRaw === "active" || listFilterRaw === "idle" ? listFilterRaw : "all";
  const setListFilter = (v: ListFilter) => setListFilterRaw(v);
  const [urlQuery, setUrlQuery] = useUrlSearchValue("q", "");
  const [searchDraft, setSearchDraft] = useState(urlQuery);
  useEffect(() => {
    setSearchDraft(urlQuery);
  }, [urlQuery]);
  useEffect(() => {
    if (searchDraft === urlQuery) return;
    const handle = window.setTimeout(() => setUrlQuery(searchDraft), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchDraft, urlQuery, setUrlQuery]);

  // Master-detail selection — URL slot `?selected=<scope>/<short>`.
  // Deliberately NOT `?agent=` (that key is the filter-by-agent slot on
  // /runtime/tasks and /runtime/sessions; overloading it cross-page would
  // corrupt those filters when a user navigated to/from this page).
  const [selectedUrl, setSelectedUrl] = useUrlSearchValue("selected", "");
  const selectedFqn = selectedUrl === "" ? null : selectedUrl;

  const refreshTasks = useCallback(async () => {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    try {
      const next = await listTasks({ createdSince: since, origin: "all" });
      if (!mountedRef.current) return;
      setTasks(next);
      setTasksError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setTasksError(e instanceof Error ? e.message : String(e));
      setTasks((prev) => (prev === null ? [] : prev));
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  usePollWithBackoff(refreshTasks, pollIntervalMs, true);

  // Per-selected-agent sessions. Refresh only when something is selected;
  // when selection clears the polling stops (the `enabled` flag below is
  // false), and any cached list is wiped synchronously by the reset effect
  // so a stale right pane doesn't flash.
  const refreshSessions = useCallback(async () => {
    if (selectedFqn === null) return;
    try {
      const s = await listSessions({ agent: selectedFqn });
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
  }, [selectedFqn]);

  // Wipe per-agent sessions state when selection changes (or clears) so
  // the previous agent's list doesn't bleed into the new right pane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate fqn-only reset; the lists belong to the previous selection and must be cleared synchronously when fqn changes
  useEffect(() => {
    setSessions(null);
    setSessionsError(null);
  }, [selectedFqn]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  usePollWithBackoff(refreshSessions, pollIntervalMs, selectedFqn !== null);

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

  // PR #189 polish v3 — DO NOT gate views computation on `tasks !== null`.
  // The agent identities come from the shell-preloaded `data.agents`, so
  // rows must render immediately. The tasks fetch only contributes per-row
  // runtime augmentation (the "X running" tag) — when it's pending, the
  // computed counts are all 0 but `runtimeLoading=true` lets each row
  // render a skeleton so the UI doesn't lie about an idle state.
  const views: AgentRuntimeView[] = useMemo(
    () => computeAgentRuntimeViews(data.agents, tasks ?? []),
    [data.agents, tasks],
  );
  const runtimeLoading = tasks === null;

  const filteredViews = useMemo(() => {
    const q = urlQuery.trim().toLowerCase();
    return views.filter((v) => {
      if (listFilter === "active" && v.runningTasks <= 0) return false;
      if (listFilter === "idle" && v.runningTasks > 0) return false;
      if (q !== "") {
        const [scope, short] = splitForDisplay(v.entry.agent.fqn);
        const haystack = `${short} ${scope} ${v.entry.agent.fqn}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [views, listFilter, urlQuery]);

  // Auto-select-first-row fallback, derived during render (Phase 1.5
  // Block G — see file-level comment). URL selection is authoritative
  // when present; the pane honours an out-of-list fqn so the
  // "not installed" alert keeps surfacing for stale deeplinks. The
  // fallback fires the moment `data.agents` populates — PR #189 polish
  // v3 dropped the `tasks !== null` precondition that used to hold the
  // right pane in its placeholder state across the entire tasks fetch.
  const effectiveSelectedFqn = useMemo(() => {
    if (selectedFqn !== null) return selectedFqn;
    if (filteredViews.length > 0) return filteredViews[0]?.entry.agent.fqn ?? null;
    return null;
  }, [selectedFqn, filteredViews]);

  // Catalog entry for the selected fqn (null when the agent isn't
  // installed — the pane renders the "not installed" alert in that case).
  const selectedEntry: AgentEntry | null = useMemo(() => {
    if (effectiveSelectedFqn === null) return null;
    return data.agents.find((a) => a.agent.fqn === effectiveSelectedFqn) ?? null;
  }, [effectiveSelectedFqn, data.agents]);

  // Per-selected-agent tasks derived from the workspace-wide list. `null`
  // while the workspace fetch is in flight so the pane renders its own
  // loading state instead of flipping to "Idle" prematurely.
  const selectedTasks = useMemo<TaskRecord[] | null>(() => {
    if (tasks === null || effectiveSelectedFqn === null) return null;
    return tasks.filter((t) => t.agent === effectiveSelectedFqn);
  }, [tasks, effectiveSelectedFqn]);

  // PR #189 polish v3 — collapse the split layout to a single full-width
  // empty state when the workspace itself has zero installed agents.
  // Without this the right pane shows the redundant "Select an agent"
  // placeholder next to the same call-to-action on the left.
  const workspaceEmpty = data.agents.length === 0;
  const containerClass = `tasks-pane tasks-pane--with-detail${workspaceEmpty ? " tasks-pane--zero" : ""}`;

  return (
    <div className="agents-page" data-testid="agents-page">
      {tasksError && <div className="alert alert--error">⚠️ {tasksError}</div>}

      <div className={containerClass}>
        {workspaceEmpty ? (
          <AgentsZeroState wsId={wsId} />
        ) : (
          <>
            <div className="tasks-pane__list">
              <div className="agents-list-toolbar">
                <fieldset
                  className="pills"
                  aria-label="Filter agents by status"
                  data-testid="agents-list-filter-tabs"
                >
                  {LIST_FILTER_TABS.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      className={`pills__btn${listFilter === t.value ? " pills__btn--active" : ""}`}
                      onClick={() => setListFilter(t.value)}
                      aria-pressed={listFilter === t.value}
                      data-testid={`agents-list-filter-${t.value}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </fieldset>
                <input
                  type="search"
                  className="input agents-list-toolbar__search"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  placeholder="Search agents…"
                  aria-label="Search agents by name, scope, or fqn"
                  data-testid="agents-list-search"
                />
              </div>
              <div className="tasks-pane__list-scroll">
                {filteredViews.length === 0 ? (
                  <div className="empty" data-testid="agents-list-filter-empty">
                    <div className="empty__icon" aria-hidden="true">
                      🔎
                    </div>
                    <p className="empty__title">No agents match the current filters</p>
                    <p className="empty__hint">
                      Try clearing the search or switching the status tab.
                    </p>
                  </div>
                ) : (
                  <ul
                    className="agents-list"
                    aria-label="Installed agents"
                    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA listbox/option pattern
                    role="listbox"
                  >
                    {filteredViews.map((v) => (
                      <AgentRow
                        key={v.entry.agent.fqn}
                        view={v}
                        selected={effectiveSelectedFqn === v.entry.agent.fqn}
                        onSelect={() => setSelectedUrl(v.entry.agent.fqn)}
                        runtimeLoading={runtimeLoading}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {effectiveSelectedFqn !== null ? (
              <AgentDetailPane
                fqn={effectiveSelectedFqn}
                entry={selectedEntry}
                wsId={wsId}
                tasks={selectedTasks}
                sessions={sessions}
                tasksError={null}
                sessionsError={sessionsError}
              />
            ) : (
              <AgentDetailPlaceholder />
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface AgentsZeroStateProps {
  wsId: string;
}

/**
 * Full-width single-pane empty rendered when the workspace has zero
 * installed agents (PR #189 polish v3 — collapses the split layout
 * "two empty placeholders side by side" duplication into one). The
 * CTA links to Catalog because agent install isn't an in-page modal.
 */
function AgentsZeroState({ wsId }: AgentsZeroStateProps) {
  return (
    <div className="empty tasks-pane__zero" data-testid="agents-empty-zero">
      <div className="empty__icon" aria-hidden="true">
        🤖
      </div>
      <p className="empty__title">No agents installed</p>
      <p className="empty__hint">
        Agents wrap skills + MCPs into runnable templates. Install one in the Catalog to see its
        runtime status here.
      </p>
      <Link
        to={`/workspaces/${encodeURIComponent(wsId)}/catalog/agents`}
        className="btn btn--primary"
        data-testid="agents-empty-zero-cta"
      >
        Open Catalog
      </Link>
    </div>
  );
}

/**
 * Right-pane placeholder rendered when no agent is selected but the
 * workspace has at least one agent (filtered-to-zero / no-pick-yet case).
 * Sibling to {@link AgentDetailPane}; both share the `.tasks-pane__detail*`
 * layout primitives from the Tasks page (PR #189 polish v2 §9 option A).
 * The zero-workspace case is handled by {@link AgentsZeroState} at the
 * grid level instead so the two placeholders don't render simultaneously.
 */
function AgentDetailPlaceholder() {
  return (
    <aside
      className="tasks-pane__detail tasks-pane__detail--empty"
      data-testid="agent-detail-placeholder"
    >
      <div className="empty">
        <div className="empty__icon" aria-hidden="true">
          🤖
        </div>
        <p className="empty__title">Select an agent from the list</p>
        <p className="empty__hint">
          Pick a row on the left to see its activity, sessions, and recent tasks.
        </p>
      </div>
    </aside>
  );
}

interface AgentRowProps {
  view: AgentRuntimeView;
  /** True when this row is the currently-selected one. */
  selected: boolean;
  /** Click / keyboard activation — writes `?selected=<fqn>` via the parent. */
  onSelect: () => void;
  /** True while the workspace-wide tasks fetch is still pending; row hides
   *  the running-count tag behind a skeleton so we don't lie about idle. */
  runtimeLoading: boolean;
}

/**
 * One row of the agents list. Two-column layout:
 *
 *   left  — `AgentAvatar` + `AgentFqn` two-tone + muted subline
 *   right — status pill stacked above an activity tag
 *
 * PR #189 polish v3 row redesign:
 *   - Avatar reinforces scope disambiguation (deterministic colour on
 *     the FULL fqn).
 *   - FQN renders as `scope/short` two-tone so users see the full
 *     identity without the scope being relegated to a muted secondary
 *     line.
 *   - The previous per-row kebab menu was deleted: every menu item
 *     duplicated affordances already in the detail pane, and removing
 *     it eliminates the `stopPropagation` carve-out keeping the click
 *     target simple — "the entire row selects the agent, period".
 */
function AgentRow({ view, selected, onSelect, runtimeLoading }: AgentRowProps) {
  const { agent } = view.entry;
  const [, short] = splitForDisplay(agent.fqn);
  return (
    <li
      className={`agents-list__item${selected ? " agents-list__item--selected" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA listbox/option pattern
      role="option"
      tabIndex={0}
      aria-selected={selected}
      aria-current={selected ? "true" : undefined}
      data-testid={`agent-row-${agent.fqn}`}
    >
      <AgentAvatar fqn={agent.fqn} label={short} size="md" />
      <div className="agents-list__identity">
        <AgentFqn fqn={agent.fqn} />
        <span className="agents-list__subline muted">
          {view.status === "running" ? "Active" : "Idle"} · v{agent.version}
        </span>
      </div>
      <div className="agents-list__status-col">
        <AgentStatusPill status={view.status} />
        <span
          className="agents-list__activity muted"
          data-testid={`agent-row-activity-${agent.fqn}`}
        >
          {runtimeLoading ? (
            <span
              className="skeleton skeleton--text"
              role="status"
              aria-label="Loading activity"
              data-testid={`agent-row-activity-skeleton-${agent.fqn}`}
            />
          ) : view.runningTasks > 0 ? (
            `${view.runningTasks} running`
          ) : (
            "Idle"
          )}
        </span>
      </div>
    </li>
  );
}

function splitForDisplay(fqn: string): [string, string] {
  const parts = splitFqn(fqn);
  if (parts !== null) return [parts.scope, parts.short];
  const ix = fqn.indexOf("/");
  if (ix <= 0) return ["", fqn];
  return [fqn.slice(0, ix), fqn.slice(ix + 1)];
}

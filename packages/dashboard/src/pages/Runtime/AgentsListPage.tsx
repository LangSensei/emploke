import type { AgentEntry } from "@emploke/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listSessions, listTasks, type SessionView, type TaskRecord } from "../../api";
import { AgentAvatar } from "../../components/agents/AgentAvatar";
import { AgentFqn } from "../../components/agents/AgentFqn";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import { useClickOutside } from "../../hooks/useClickOutside";
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

  // PR #189 polish v3 — DO NOT gate views computation on `tasks !== null`.
  // The agent identities come from the shell-preloaded `data.agents`, so
  // rows must render immediately. The tasks fetch only contributes per-row
  // runtime augmentation (the "X running" tag) — when it's pending, the
  // computed counts are all 0 but `runtimeLoading=true` lets each row
  // render a skeleton so the UI doesn't lie about an idle state.
  //
  // PR #189 polish v4 — the `views` / `filteredViews` / `effectiveSelectedFqn`
  // chain is computed BEFORE the sessions fetch (below) because
  // `refreshSessions` and its wipe/poll-enabled siblings now key off
  // `effectiveSelectedFqn`, not `selectedFqn`. Without that re-key the
  // right pane on the auto-selected row stays stuck on "Loading…"
  // forever — the URL `?selected=` slot is empty on first paint, so
  // `selectedFqn === null` short-circuits the sessions fetch even
  // though the pane has resolved a real fqn via the auto-select
  // fallback. See `.pilot/inbox/20260525-v4-activity-loading-hang.md`.
  const views: AgentRuntimeView[] = useMemo(
    () => computeAgentRuntimeViews(data.agents, tasks ?? []),
    [data.agents, tasks],
  );
  const runtimeLoading = tasks === null;

  const filteredViews = useMemo(() => {
    const q = urlQuery.trim().toLowerCase();
    const result = views.filter((v) => {
      if (listFilter === "active" && v.runningTasks <= 0) return false;
      if (listFilter === "idle" && v.runningTasks > 0) return false;
      if (q !== "") {
        const [scope, short] = splitForDisplay(v.entry.agent.fqn);
        const haystack = `${short} ${scope} ${v.entry.agent.fqn}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    // PR #189 polish v4 Bug 5 — running-first ordering so active
    // work is immediately visible. Within each bucket, fall back to
    // FQN for stable, predictable ordering (the secondary key does
    // NOT use `runningTasks` count -- otherwise rows would jiggle
    // every poll as task counts changed between active agents).
    // The auto-select fallback (`filteredViews[0]`) therefore picks
    // the topmost active agent on the default `all` filter, which
    // matches what a user opening /runtime/agents expects to land
    // on. See `.pilot/inbox/20260525-v4-agent-list-sort.md`.
    result.sort((a, b) => {
      const aActive = a.runningTasks > 0 ? 1 : 0;
      const bActive = b.runningTasks > 0 ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return a.entry.agent.fqn.localeCompare(b.entry.agent.fqn);
    });
    return result;
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

  // Per-selected-agent sessions. Refresh only when something is
  // effectively selected (URL `?selected=` OR the auto-select
  // fallback); when selection clears the polling stops (the `enabled`
  // flag below is false), and any cached list is wiped synchronously
  // by the reset effect so a stale right pane doesn't flash.
  //
  // PR #189 polish v4 — keys off `effectiveSelectedFqn`, not the raw
  // URL `selectedFqn`, so the auto-selected row's sessions fetch
  // actually fires on first paint. The old `selectedFqn`-only guard
  // never fired when the user landed on the page without a
  // `?selected=` query param, leaving `AgentOverviewTab` stuck on
  // "Loading…" forever.
  const refreshSessions = useCallback(async () => {
    if (effectiveSelectedFqn === null) return;
    try {
      const s = await listSessions({ agent: effectiveSelectedFqn });
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
  }, [effectiveSelectedFqn]);

  // Wipe per-agent sessions state when the effective selection changes
  // (or clears) so the previous agent's list doesn't bleed into the
  // new right pane. Keys off `effectiveSelectedFqn` for the same
  // reason as `refreshSessions` above — both must agree on the same
  // fqn or the wipe runs against a stale identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate fqn-only reset; the lists belong to the previous selection and must be cleared synchronously when fqn changes
  useEffect(() => {
    setSessions(null);
    setSessionsError(null);
  }, [effectiveSelectedFqn]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  usePollWithBackoff(refreshSessions, pollIntervalMs, effectiveSelectedFqn !== null);

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
                <input
                  type="search"
                  className="input agents-list-toolbar__search"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  placeholder="Search agents…"
                  aria-label="Search agents by name, scope, or fqn"
                  data-testid="agents-list-search"
                />
                {/*
                  PR #189 polish v3 — the previous inline pill bar
                  (All / Active / Idle) was replaced with a FilterMenu
                  popover button so the toolbar stays at one row of
                  chrome regardless of how many filter dimensions we
                  add later (sort, group, etc.). Comment matches the
                  rationale on the Catalog filter (the original
                  primitive of this pattern in pages/Catalog.tsx).

                  When the active filter is anything other than "All",
                  the button title shows the picked value and a small
                  indicator so it's still obvious from a glance that a
                  filter is constraining the view.
                */}
                <AgentsFilterMenu value={listFilter} onChange={setListFilter} />
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

interface AgentsFilterMenuProps {
  value: ListFilter;
  onChange: (next: ListFilter) => void;
}

const FILTER_LABEL: Record<ListFilter, string> = {
  all: "All",
  active: "Active",
  idle: "Idle",
};

/**
 * Per-page filter menu rendered as a popover-triggered radio group.
 * Mirrors the FilterMenu pattern from `pages/Catalog.tsx` (state-driven
 * open/close, `useClickOutside` to dismiss, Escape handler) so the two
 * agentic-control-plane pages keep the same toolbar shape.
 *
 * PR #189 polish v3 replaced the inline pill bar
 * (`<button>All</button> <button>Active</button> ...`) with this popover
 * so the toolbar stays at one row of chrome regardless of how many
 * filter dimensions we add later (sort, group, etc.).
 */
function AgentsFilterMenu({ value, onChange }: AgentsFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  const outsideRefs = useMemo(() => [triggerRef, panelRef] as const, []);
  useClickOutside(outsideRefs, close, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const activeLabel = FILTER_LABEL[value];
  const isFiltered = value !== "all";

  return (
    <div className="filter-menu" data-testid="agents-filter-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn--ghost filter-menu__trigger${
          isFiltered ? " filter-menu__trigger--active" : ""
        }`}
        title={isFiltered ? `Showing ${activeLabel} only` : "Filter by status"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        data-testid="agents-filter-menu-trigger"
      >
        <span className="filter-menu__icon" aria-hidden="true">
          ⚙
        </span>
        Filters
        {isFiltered && (
          <>
            <span className="filter-menu__sep" aria-hidden="true">
              ·
            </span>
            <span className="filter-menu__current">{activeLabel}</span>
          </>
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          className="filter-menu__panel"
          role="menu"
          data-testid="agents-filter-menu-panel"
        >
          <div className="filter-menu__group-label">Status</div>
          {LIST_FILTER_TABS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === opt.value}
              className={`filter-menu__option${
                value === opt.value ? " filter-menu__option--active" : ""
              }`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              data-testid={`agents-list-filter-${opt.value}`}
            >
              <span className="filter-menu__radio" aria-hidden="true">
                {value === opt.value ? "●" : "○"}
              </span>
              <span className="filter-menu__option-label">{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

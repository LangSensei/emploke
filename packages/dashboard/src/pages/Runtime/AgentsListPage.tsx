import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listTasks, type TaskRecord } from "../../api";
import { MoreHorizontalIcon } from "../../components/Icons";
import { useBreadcrumb, useWorkspaceShell } from "../../components/WorkspaceShellContext";
import { usePollWithBackoff } from "../../hooks/usePollWithBackoff";
import { useUrlSearchValue } from "../../hooks/useUrlState";
import {
  type AgentRuntimeView,
  AgentStatusPill,
  agentDetailUrl,
  computeAgentRuntimeViews,
  splitFqn,
} from "./agentRuntime";

const DEFAULT_POLL_INTERVAL_MS = 4000;

/**
 * `?filter=` URL slot values (Phase 1.5 §4.2 / Block H). `all` is the
 * default; `active` narrows to agents currently running ≥ 1 task;
 * `idle` is the complement.
 */
type ListFilter = "all" | "active" | "idle";
const LIST_FILTER_TABS: ReadonlyArray<{ value: ListFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "idle", label: "Idle" },
];

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Monitor-only list of every installed agent in the workspace with a
 * live status pill computed from the running-task list. Phase 1.5
 * §4.2 / Block H adds status filter tabs, debounced URL-backed search,
 * and a per-row kebab menu (Open / View tasks / View sessions).
 *
 * The polling cadence and the "legacy URL moved" banner concerns are
 * unchanged from PR #189 polish — the banner host moved to the new
 * global Sessions/Tasks pages in Block F since those are the redirect
 * targets now.
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

  // URL-driven filter state — `?filter=` for the status tab and
  // `?q=` for the search box. The search input also keeps a 200ms
  // debounced local mirror so each keystroke doesn't replace a
  // history entry.
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

  const refresh = useCallback(async () => {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    try {
      const next = await listTasks({ createdSince: since, origin: "all" });
      if (!mountedRef.current) return;
      setTasks(next);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setTasks((prev) => (prev === null ? [] : prev));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePollWithBackoff(refresh, pollIntervalMs, true);

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

  return (
    <div className="agents-list-page">
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
            Visit <Link to={`/workspaces/${encodeURIComponent(wsId)}/catalog/agents`}>Catalog</Link>{" "}
            to install agents into this workspace.
          </p>
        </div>
      ) : filteredViews.length === 0 ? (
        <div className="empty">
          <div className="empty__icon" aria-hidden="true">
            🔎
          </div>
          <p className="empty__title">No agents match the current filters</p>
          <p className="empty__hint">Try clearing the search or switching the status tab.</p>
        </div>
      ) : (
        <ul className="agents-list" aria-label="Installed agents">
          {filteredViews.map((v) => (
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
  const to = agentDetailUrl(wsId, scope, short);
  const tasksHref = `/workspaces/${encodeURIComponent(wsId)}/runtime/tasks?agent=${agent.fqn}`;
  const sessionsHref = `/workspaces/${encodeURIComponent(wsId)}/runtime/sessions?agent=${agent.fqn}`;
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
          <span>Running {view.runningTasks}</span>
          <span className="agents-list__sep">·</span>
          <span>Total {view.totalTasks7d} (7d)</span>
          <span className="agents-list__sep">·</span>
          <span>v{agent.version}</span>
        </div>
      </Link>
      <AgentRowMenu openHref={to} tasksHref={tasksHref} sessionsHref={sessionsHref} />
    </li>
  );
}

interface AgentRowMenuProps {
  openHref: string;
  tasksHref: string;
  sessionsHref: string;
}

/**
 * Per-row kebab menu rendered top-right of every agent card. Uses
 * native `<details><summary>` so we don't pull in `@radix-ui` or a
 * sibling dropdown library just for this round (C5 bundle budget).
 */
function AgentRowMenu({ openHref, tasksHref, sessionsHref }: AgentRowMenuProps) {
  const stopBubble = useCallback((e: React.SyntheticEvent) => {
    // Click and keyboard activation on the menu container would
    // otherwise bubble into the surrounding agents-list <Link> row
    // and trigger navigation.
    e.stopPropagation();
  }, []);
  return (
    <details
      className="agents-list__menu"
      data-testid="agent-row-menu"
      onClick={stopBubble}
      onKeyDown={stopBubble}
    >
      <summary
        className="agents-list__menu-trigger"
        aria-label="Agent actions"
        title="Agent actions"
      >
        <MoreHorizontalIcon className="agents-list__menu-icon" />
      </summary>
      <div className="agents-list__menu-panel" role="menu">
        <Link to={openHref} className="agents-list__menu-item" role="menuitem">
          Open
        </Link>
        <Link
          to={tasksHref}
          className="agents-list__menu-item"
          role="menuitem"
          data-testid="agent-row-menu-tasks"
        >
          View tasks
        </Link>
        <Link
          to={sessionsHref}
          className="agents-list__menu-item"
          role="menuitem"
          data-testid="agent-row-menu-sessions"
        >
          View sessions
        </Link>
      </div>
    </details>
  );
}

function splitForDisplay(fqn: string): [string, string] {
  const parts = splitFqn(fqn);
  if (parts !== null) return [parts.scope, parts.short];
  const ix = fqn.indexOf("/");
  if (ix <= 0) return ["", fqn];
  return [fqn.slice(0, ix), fqn.slice(ix + 1)];
}

import type { AgentEntry } from "@emploke/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  deleteTask,
  dispatchTask,
  listRuntimes,
  listTasks,
  type ServerConfig,
  type TaskRecord,
} from "../../api";
import { PlusIcon, RefreshIcon } from "../../components/Icons";
import { usePollWithBackoff } from "../../hooks/usePollWithBackoff";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { DispatchModal } from "./DispatchTaskModal";
import {
  ALL_AGENTS,
  ALL_RUNTIMES,
  DEFAULT_POLL_INTERVAL_MS,
  presetToSinceMs,
  TIME_PRESETS,
  type TimePreset,
} from "./status";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { TaskTable } from "./TaskTable";

interface TasksProps {
  agents: AgentEntry[];
  /** UUID of the workspace currently in scope (from the URL); null = no workspace. */
  currentWorkspaceId: string | null;
  /** Server-supplied config; null while still being fetched. */
  config: ServerConfig | null;
}

/**
 * Tasks page — fire-and-forget agent dispatch, autonomous run, polling
 * detail view. Mirrors Sessions's filter+toolbar UX so users can move
 * between the two pages without re-learning the layout.
 *
 * Layout is a true split-pane with collapsible detail. Selection is
 * URL-driven (`/workspaces/<wsId>/tasks/<taskId>`), so refreshes,
 * shared links, and the browser back button all preserve "which task
 * am I looking at". The right panel collapses when no task is selected
 * (URL = `/workspaces/<wsId>/tasks`), giving the list the full width.
 *
 * The list scrolls independently of the detail panel (each gets its
 * own `overflow: auto` container with `align-self: start`), so a long
 * event log on the right doesn't make left-side rows balloon.
 */
export function TasksPage({ agents, currentWorkspaceId, config }: TasksProps) {
  // URL-driven selection. The router declares /workspaces/:wsId/:section/:tab,
  // so for tasks the `tab` slot carries the task id. We read it via the
  // params hook (which always returns the current URL state, even after
  // browser back/forward) and write it via navigate(); the local state
  // mirror is just for derived computations that don't want to re-call
  // useParams on every render.
  const params = useParams<{ wsId: string; section?: string; tab?: string }>();
  const navigate = useNavigate();
  const selectedId = params.tab ?? null;
  const setSelectedId = useCallback(
    (id: string | null) => {
      const ws = encodeURIComponent(currentWorkspaceId ?? "");
      navigate(id === null ? `/workspaces/${ws}/tasks` : `/workspaces/${ws}/tasks/${id}`);
    },
    [navigate, currentWorkspaceId],
  );

  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskRecord | null>(null);
  /**
   * `true` = purge mode (also wipe workdir). `false` = archive (default;
   * only the metadata row goes). Reset to `false` on every new
   * `setDeleteTarget(...)`.
   */
  const [deletePurge, setDeletePurge] = useState(false);

  // Re-run-prefill state: when set, opens the DispatchModal pre-filled
  // with these values so "re-run" is one click + Enter rather than a
  // copy-paste between detail and create modal.
  const [rerunFrom, setRerunFrom] = useState<TaskRecord | null>(null);

  // Filter state — all client-side, since /tasks returns the full list and
  // the list is small enough that filtering in JS is cheaper than a round-trip.
  const [agentFilter, setAgentFilter] = useState<string>(ALL_AGENTS);
  const [runtimeFilter, setRuntimeFilter] = useState<string>(ALL_RUNTIMES);
  const [timeFilter, setTimeFilter] = useState<TimePreset>("7d");
  const [idQuery, setIdQuery] = useState("");

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Race guards for `refresh()`. Both work together:
  //   * `wsTokenRef` captures the workspace at the moment a fetch begins;
  //     if the user navigates to a different workspace before the fetch
  //     resolves, we drop the response on the floor instead of writing
  //     stale data into the new workspace's state. (Workspace switching
  //     re-renders this component with a new `currentWorkspaceId` prop
  //     rather than remounting, so `mountedRef` does NOT catch this.)
  //   * `inFlightRef` lets the polling effect skip a tick when the
  //     previous refresh hasn't returned yet, preventing request pile-up
  //     on slow networks or large task lists.
  const wsTokenRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!currentWorkspaceId) {
      setTasks([]);
      setLoaded(true);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const token = currentWorkspaceId;
    wsTokenRef.current = token;
    setRefreshing(true);
    try {
      // Push the filter dimensions the server understands down as query
      // params. `idQuery` (substring on id) stays client-side because
      // it's a UX-level fuzzy-match the server doesn't model. The
      // server returns only matching rows, so the wire payload + the
      // visible-tasks `useMemo` below shrink in lockstep.
      const sinceMs = presetToSinceMs(timeFilter);
      const opts: Parameters<typeof listTasks>[0] = {};
      if (agentFilter !== ALL_AGENTS) opts.agent = agentFilter;
      if (runtimeFilter !== ALL_RUNTIMES) opts.runtime = runtimeFilter;
      if (sinceMs !== null) opts.createdSince = new Date(sinceMs).toISOString();
      const next = await listTasks(opts);
      // Bail if (a) component unmounted, (b) workspace changed during
      // the fetch — listTasks() resolved against the old prefix but the
      // user is now looking at a different workspace.
      if (!mountedRef.current) return;
      if (token !== currentWorkspaceId) return;
      setError(null);
      // Newest-first by createdAt — id is also timestamp-prefixed but
      // sorting on createdAt is the contract we want to depend on.
      next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setTasks(next);
    } catch (e) {
      if (!mountedRef.current) return;
      if (token !== currentWorkspaceId) return;
      setError((e as Error).message);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && token === currentWorkspaceId) {
        setRefreshing(false);
        setLoaded(true);
      }
    }
  }, [currentWorkspaceId, agentFilter, runtimeFilter, timeFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch the registered runtimes once at mount. Static for a given server
  // process so re-polling is wasteful. If the call fails (server unreachable
  // on mount), we just leave the dropdown disabled / showing "(default)" —
  // the dispatch path then submits without a `runtime` field and the server
  // picks its default.
  useEffect(() => {
    let cancelled = false;
    listRuntimes()
      .then((rts) => {
        if (!cancelled) setRuntimes(rts.map((r) => r.kind));
      })
      .catch(() => {
        // Non-fatal.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-refresh while any task is running so the dashboard catches the
  // success/failure transition without the user pressing Refresh.
  // The cadence is server-supplied via /api/config (operators can tune
  // it for very large workspaces); we fall back to the same default the
  // server uses when config hasn't loaded yet. `usePollWithBackoff`
  // chains polls via setTimeout and exponentially backs off when the
  // server is unreachable, so a sleeping laptop or restarted server no
  // longer floods the network panel with red ECONNREFUSED rows.
  const pollIntervalMs = config?.tasks?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const anyRunning = useMemo(
    () => tasks.some((t) => t.status === "running" || t.status === "not_started"),
    [tasks],
  );
  usePollWithBackoff(refresh, pollIntervalMs, anyRunning && !!currentWorkspaceId);

  const onDispatched = async (agent: string, instructions: string, runtime: string | undefined) => {
    setBusy(true);
    setError(null);
    try {
      const created = await dispatchTask(agent, instructions, runtime);
      if (!mountedRef.current) return;
      setDispatchOpen(false);
      setRerunFrom(null);
      setSelectedId(created.id);
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const onConfirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    try {
      await deleteTask(deleteTarget.id, { purge: deletePurge });
      if (!mountedRef.current) return;
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
      setDeletePurge(false);
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  /** Open the dispatch modal pre-populated with another task's params. */
  const onRerun = (source: TaskRecord) => {
    setRerunFrom(source);
    setDispatchOpen(true);
  };

  const readyAgents = agents.filter((a) => a.status === "ready");

  // Memoize so re-renders triggered by polling don't re-allocate the array
  // unless the underlying data actually changed. Note: agent / runtime /
  // time-preset filters are applied server-side in `refresh()` above —
  // `tasks` here is already the filtered set. We only re-filter on
  // `idQuery` here because substring search is a UX-level fuzzy match
  // the server doesn't model; pushing it down would require an unindexed
  // contains scan that's no cheaper than what we're doing in JS.
  const visibleTasks = useMemo(() => {
    const q = idQuery.trim().toLowerCase();
    if (q === "") return tasks;
    return tasks.filter((t) => t.id.toLowerCase().includes(q));
  }, [tasks, idQuery]);

  // Drop the URL-bound selection if the task is truly gone from the
  // task list (deleted server-side, or never existed when navigating
  // to a stale link). We deliberately do NOT clear selection just
  // because client-side `idQuery` filters it out — the user typed a
  // filter to *narrow the list*, not to discard the panel they're
  // reading. Only kicks in once `loaded` so we don't blow away a
  // valid deep-link before the first list fetch resolves.
  useEffect(() => {
    if (!loaded) return;
    if (selectedId !== null && !tasks.some((t) => t.id === selectedId)) {
      setSelectedId(null);
    }
  }, [loaded, selectedId, tasks, setSelectedId]);

  // Distinct agent / runtime values that actually appear in the task list,
  // unioned with the catalog list so users can filter to an agent that
  // doesn't have any tasks yet (giving a "no matches" empty state instead
  // of hiding the option entirely).
  const filterAgentNames = useMemo(() => {
    const set = new Set<string>(agents.map((a) => a.agent.fqn));
    for (const t of tasks) set.add(t.agent);
    return Array.from(set).sort();
  }, [agents, tasks]);

  if (currentWorkspaceId === null) {
    return (
      <div className="alert alert--error">
        No workspace is selected. Use the workspace dropdown in the top bar to choose or create one
        — tasks are scoped to a workspace.
      </div>
    );
  }

  return (
    <>
      <div className="page-toolbar">
        <div
          className="page-toolbar__actions"
          style={{ gap: "var(--space-3)", alignItems: "center" }}
        >
          <label htmlFor="task-id-filter" className="muted" style={{ fontSize: 12 }}>
            Search
          </label>
          <input
            id="task-id-filter"
            type="search"
            value={idQuery}
            onChange={(e) => setIdQuery(e.target.value)}
            placeholder="task id…"
            className="input"
            // Task ids are fixed-width (`YYYYMMDD-xxxxxxxx`, 17 chars).
            // 160px is the sweet spot — holds the full id, the search-input
            // clear-x, and a bit of breathing room. The original 200px was
            // wasted; 150 was a hair too tight.
            style={{ width: 160 }}
          />
          <label htmlFor="task-agent-filter" className="muted" style={{ fontSize: 12 }}>
            Agent
          </label>
          <select
            id="task-agent-filter"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="select"
          >
            <option value={ALL_AGENTS}>All</option>
            {filterAgentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <label htmlFor="task-runtime-filter" className="muted" style={{ fontSize: 12 }}>
            Runtime
          </label>
          <select
            id="task-runtime-filter"
            value={runtimeFilter}
            onChange={(e) => setRuntimeFilter(e.target.value)}
            className="select"
            disabled={runtimes.length === 0}
          >
            <option value={ALL_RUNTIMES}>All</option>
            {runtimes.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            Created
          </span>
          <div className="pills">
            {TIME_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`pills__btn${timeFilter === p.value ? " pills__btn--active" : ""}`}
                onClick={() => setTimeFilter(p.value)}
                aria-pressed={timeFilter === p.value}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="page-toolbar__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshIcon className={refreshing ? "spin" : undefined} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setDispatchOpen(true)}
            disabled={readyAgents.length === 0}
            title={
              readyAgents.length === 0
                ? "Install at least one ready agent in the Catalog first"
                : "Dispatch a new task"
            }
          >
            <PlusIcon />
            <span>Dispatch task</span>
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">⚠️ {error}</div>}

      {!loaded ? (
        <div className="empty">
          <div className="empty__icon spin" aria-hidden="true">
            <RefreshIcon />
          </div>
          <p className="empty__title">Loading tasks…</p>
        </div>
      ) : visibleTasks.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">📝</div>
          <p className="empty__title">{tasks.length === 0 ? "No tasks yet" : "No matches"}</p>
          <p className="empty__hint">
            {tasks.length === 0
              ? "Dispatch a task to run an agent autonomously and read the result here when it finishes."
              : "Adjust the filters above to see more tasks."}
          </p>
        </div>
      ) : (
        // Split-pane: list scrolls independently; right panel collapses
        // when no task is selected (URL = /workspaces/.../tasks). Each
        // pane caps its own height to viewport-minus-toolbar so the
        // page itself never grows scrollbars regardless of content.
        <div className={`tasks-pane${selectedId ? "" : " tasks-pane--list-only"}`}>
          <div className="tasks-pane__list">
            <TaskTable
              tasks={visibleTasks}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onDelete={setDeleteTarget}
            />
          </div>

          {selectedId && (
            <TaskDetailPanel
              taskId={selectedId}
              onClose={() => setSelectedId(null)}
              onRerun={onRerun}
              pollIntervalMs={pollIntervalMs}
            />
          )}
        </div>
      )}

      <DispatchModal
        open={dispatchOpen}
        agents={readyAgents}
        runtimes={runtimes}
        busy={busy}
        prefill={rerunFrom}
        onClose={() => {
          setDispatchOpen(false);
          setRerunFrom(null);
        }}
        onDispatch={onDispatched}
      />

      {deleteTarget && (
        <DeleteConfirmModal
          target={deleteTarget}
          purge={deletePurge}
          busy={busy}
          onPurgeChange={setDeletePurge}
          onCancel={() => {
            setDeleteTarget(null);
            setDeletePurge(false);
          }}
          onConfirm={onConfirmDelete}
        />
      )}
    </>
  );
}

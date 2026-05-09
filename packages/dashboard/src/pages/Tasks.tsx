import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteTask,
  dispatchTask,
  fetchTaskEvents,
  getTask,
  listRuntimes,
  listTasks,
  type ServerConfig,
  type TaskRecord,
  type TaskStatus,
} from "../api";
import { PlusIcon, RefreshIcon, TrashIcon } from "../components/Icons";
import { Modal } from "../components/Modal";
import { usePollWithBackoff } from "../hooks/usePollWithBackoff";

interface TasksProps {
  agents: AgentEntry[];
  /** UUID of the workspace currently in scope (from the URL); null = no workspace. */
  currentWorkspaceId: string | null;
  /** Server-supplied config; null while still being fetched. */
  config: ServerConfig | null;
}

/**
 * Fallback poll cadence used while the server config is still loading or
 * if the server omits the field. Matches the server-side default in
 * `configRoutes` so behaviour is the same in either path.
 */
const DEFAULT_POLL_INTERVAL_MS = 4000;

// `cancelled` is currently unreachable — the kernel exposes the status (see
// `TaskStatus` in @emploke/task) but no manager API emits a cancel event yet.
// The label/tone are wired up so a future user-cancel API drops in without
// UI work; until then users will only ever see the other four statuses.
const STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: "Not started",
  running: "Running",
  success: "Success",
  failure: "Failure",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<TaskStatus, string> = {
  not_started: "muted",
  running: "info",
  success: "ok",
  failure: "warn",
  cancelled: "muted",
};

// Sentinel values for the "All" option in the dropdowns. Plain strings keep
// the <select value> contract simple (vs `null`, which doesn't round-trip
// through DOM string serialization).
const ALL_AGENTS = "__all__";
const ALL_RUNTIMES = "__all__";

type TimePreset = "today" | "7d" | "30d" | "all";

const TIME_PRESETS: { value: TimePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

function presetToSinceMs(preset: TimePreset): number | null {
  const now = Date.now();
  switch (preset) {
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1000;
    case "all":
      return null;
  }
}

/**
 * Tasks page — fire-and-forget agent dispatch, autonomous run, polling
 * detail view. Mirrors Sessions's filter+toolbar UX so users can move
 * between the two pages without re-learning the layout.
 *
 * Layout uses a true split-pane: the list scrolls independently of the
 * detail panel (each gets its own `overflow: auto` container with
 * `align-self: start`), so a long event log on the right doesn't make
 * left-side rows balloon. Selecting a row binds the detail panel; closing
 * the detail leaves the list untouched.
 */
export function TasksPage({ agents, currentWorkspaceId, config }: TasksProps) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskRecord | null>(null);

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
      .then((kinds) => {
        if (!cancelled) setRuntimes(kinds);
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
      await deleteTask(deleteTarget.id);
      if (!mountedRef.current) return;
      if (selectedId === deleteTarget.id) setSelectedId(null);
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
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

  // Drop the selected task from view if it's no longer in the visible set
  // (e.g. user typed a filter that excludes it). Keeps the detail pane in
  // sync with what the user can actually see.
  useEffect(() => {
    if (selectedId !== null && !visibleTasks.some((t) => t.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, visibleTasks]);

  // Distinct agent / runtime values that actually appear in the task list,
  // unioned with the catalog list so users can filter to an agent that
  // doesn't have any tasks yet (giving a "no matches" empty state instead
  // of hiding the option entirely).
  const filterAgentNames = useMemo(() => {
    const set = new Set<string>(agents.map((a) => a.agent.name));
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
            style={{ width: 200 }}
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
        // Split-pane: independent scroll containers anchored to the top
        // (`alignItems: start`) so a tall right panel doesn't push the left
        // list down and vice versa. Each child caps its own height to the
        // viewport-minus-toolbar so the page itself never grows scrollbars.
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 520px)",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div
            style={{
              maxHeight: "calc(100vh - 220px)",
              overflow: "auto",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md, 8px)",
            }}
          >
            <ul
              className="task-list"
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ARIA listbox pattern requires role on ul
              role="listbox"
              aria-label="Tasks"
            >
              {visibleTasks.map((t) => (
                <TaskListItem
                  key={t.id}
                  task={t}
                  selected={selectedId === t.id}
                  onSelect={() => setSelectedId(t.id)}
                  onDelete={() => setDeleteTarget(t)}
                />
              ))}
            </ul>
          </div>

          <TaskDetailPanel
            taskId={selectedId}
            onClose={() => setSelectedId(null)}
            pollIntervalMs={pollIntervalMs}
          />
        </div>
      )}

      <DispatchModal
        open={dispatchOpen}
        agents={readyAgents}
        runtimes={runtimes}
        busy={busy}
        onClose={() => setDispatchOpen(false)}
        onDispatch={onDispatched}
      />

      {deleteTarget && (
        <Modal open={true} onClose={() => setDeleteTarget(null)} title="Delete task" size="default">
          <div className="modal__body">
            <p>
              Delete task <code>{shortId(deleteTarget.id)}</code>? This kills the subprocess if it's
              still running and removes the workdir.
            </p>
          </div>
          <div className="modal__footer">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={onConfirmDelete}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

interface TaskListItemProps {
  task: TaskRecord;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

/**
 * One row of the task list. Renders as a card-ish flex row so a tall
 * detail panel on the right never stretches it (which is what the table
 * layout was doing — table rows in a grid cell take the cell's height).
 */
function TaskListItem({ task, selected, onSelect, onDelete }: TaskListItemProps) {
  const tone = STATUS_TONE[task.status];
  const runtime =
    typeof task.metadata?.runtime === "string" ? (task.metadata.runtime as string) : null;
  // Single-line excerpt: collapse whitespace, slice, and trust the CSS
  // ellipsis to handle the visual cut-off so we don't second-guess the
  // column width.
  const excerpt = task.instructions.replace(/\s+/g, " ").trim();
  return (
    <li
      className={`task-list__item${selected ? " task-list__item--selected" : ""}`}
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
    >
      <div className="task-list__item-head">
        <code className="task-list__id" title={task.id}>
          {shortId(task.id)}
        </code>
        <span className={`badge badge--${tone}`}>{STATUS_LABEL[task.status]}</span>
        <span className="agent-tag" title={`Agent: ${task.agent}`}>
          {task.agent}
        </span>
        {runtime && (
          <span className="agent-tag" title={`Runtime: ${runtime}`}>
            {runtime}
          </span>
        )}
        <span className="task-list__spacer" />
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete task"
          title="Delete task"
        >
          <TrashIcon />
        </button>
      </div>
      <div className="task-list__item-meta muted" title={excerpt}>
        {excerpt}
      </div>
      <div className="task-list__item-time muted">
        {task.startedAt ? formatTime(task.startedAt) : `created ${formatTime(task.createdAt)}`}
      </div>
    </li>
  );
}

interface DispatchModalProps {
  open: boolean;
  agents: AgentEntry[];
  runtimes: string[];
  busy: boolean;
  onClose: () => void;
  onDispatch: (agent: string, instructions: string, runtime: string | undefined) => void;
}

function DispatchModal({ open, agents, runtimes, busy, onClose, onDispatch }: DispatchModalProps) {
  const [agent, setAgent] = useState<string>("");
  const [runtime, setRuntime] = useState<string>("");
  const [instructions, setInstructions] = useState("");

  // Reset form on open so re-opening doesn't replay the previous dispatch.
  useEffect(() => {
    if (open) {
      setAgent(agents[0]?.agent.name ?? "");
      setRuntime(runtimes[0] ?? "");
      setInstructions("");
    }
  }, [open, agents, runtimes]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent || !instructions.trim()) return;
    onDispatch(agent, instructions.trim(), runtime || undefined);
  };

  return (
    <Modal open={open} onClose={onClose} title="Dispatch task" size="default">
      <form onSubmit={onSubmit}>
        <div className="modal__body">
          <label htmlFor="task-agent">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Agent
            </div>
            <select
              id="task-agent"
              className="select select--full"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              disabled={busy}
              required
            >
              {agents.map((a) => (
                <option key={a.agent.name} value={a.agent.name}>
                  {a.agent.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="task-runtime">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Runtime
            </div>
            <select
              id="task-runtime"
              className="select select--full"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
              disabled={busy || runtimes.length === 0}
            >
              {runtimes.length === 0 ? (
                <option value="">(server default)</option>
              ) : (
                runtimes.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))
              )}
            </select>
          </label>
          <label htmlFor="task-instructions">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Instructions
            </div>
            <textarea
              id="task-instructions"
              className="input"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="What should the agent do?"
              rows={8}
              required
              style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
            />
          </label>
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || !agent || !instructions.trim()}
          >
            {busy ? "Dispatching…" : "Dispatch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose: () => void;
  /** Auto-refresh cadence while the displayed task is running (ms). */
  pollIntervalMs: number;
}

type DetailTab = "events" | "metadata";

function TaskDetailPanel({ taskId, onClose, pollIntervalMs }: TaskDetailPanelProps) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [events, setEvents] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("events");
  const [loading, setLoading] = useState(false);

  // Race guards mirroring the list view (see TasksPage.refresh):
  //   * `mountedRef` for the standard unmount-during-fetch case
  //   * `taskTokenRef` to drop the response when the user clicks task A
  //     then task B before A's two-step fetch (getTask + fetchTaskEvents)
  //     completes — without this guard A's payload would land under B's
  //     header
  //   * `inFlightRef` to keep the auto-poll from stacking when a refresh
  //     outlives `pollIntervalMs` (a real risk on the detail panel
  //     because each cycle fires two serial fetches)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const taskTokenRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const refreshDetail = useCallback(async () => {
    if (!taskId) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const token = taskId;
    taskTokenRef.current = token;
    setLoading(true);
    try {
      const t = await getTask(taskId);
      if (!mountedRef.current || token !== taskTokenRef.current) return;
      setTask(t);
      try {
        const ev = await fetchTaskEvents(taskId);
        if (!mountedRef.current || token !== taskTokenRef.current) return;
        setEvents(ev);
        setEventsError(null);
      } catch (e) {
        if (!mountedRef.current || token !== taskTokenRef.current) return;
        setEventsError((e as Error).message);
        setEvents(null);
      }
    } catch (e) {
      if (!mountedRef.current || token !== taskTokenRef.current) return;
      setTask(null);
      setEventsError((e as Error).message);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && token === taskTokenRef.current) {
        setLoading(false);
      }
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setEvents(null);
      setEventsError(null);
      return;
    }
    void refreshDetail();
  }, [taskId, refreshDetail]);

  // Auto-poll while running so the runtime's event log + status update
  // without a manual refresh click. Cadence comes from the parent (which
  // sources it from /api/config) so list view and detail view stay in
  // sync. Backoff matches the list-view loop above.
  const detailPollEnabled = !!task && (task.status === "running" || task.status === "not_started");
  usePollWithBackoff(refreshDetail, pollIntervalMs, detailPollEnabled);

  // Common box: anchored at top of the right column with its own scroll
  // container, capped at viewport-minus-toolbar so the page never grows
  // scrollbars even with a huge event log payload.
  const boxStyle: React.CSSProperties = {
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md, 8px)",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    maxHeight: "calc(100vh - 220px)",
    overflow: "hidden",
    background: "var(--color-bg)",
  };

  if (!taskId) {
    return (
      <aside
        style={{ ...boxStyle, justifyContent: "center", alignItems: "center", minHeight: 240 }}
      >
        <p className="muted" style={{ textAlign: "center", margin: 0 }}>
          Select a task to view details.
        </p>
      </aside>
    );
  }

  // Pull the runtime exit fields out of metadata where the kernel keeps
  // them. `failure.error` is the human-readable reason; the kernel-level
  // failure type only carries that one field.
  const metadata = (task?.metadata ?? {}) as Record<string, unknown>;
  const exitCode =
    typeof metadata.exitCode === "number" || metadata.exitCode === null
      ? (metadata.exitCode as number | null)
      : undefined;
  const exitSignal = typeof metadata.exitSignal === "string" ? metadata.exitSignal : undefined;
  const runtime = typeof metadata.runtime === "string" ? metadata.runtime : undefined;

  return (
    <aside style={boxStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div>
          <code style={{ fontSize: 12 }} title={taskId}>
            {shortId(taskId)}
          </code>
          {task && (
            <span className={`badge badge--${STATUS_TONE[task.status]}`} style={{ marginLeft: 8 }}>
              {STATUS_LABEL[task.status]}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onClose}
          aria-label="Close detail"
          title="Close"
        >
          ✕
        </button>
      </div>

      {task && (
        <div className="muted" style={{ fontSize: 12, display: "grid", gap: 4 }}>
          <div>
            <strong>Agent:</strong> {task.agent}
          </div>
          {runtime && (
            <div>
              <strong>Runtime:</strong> {runtime}
            </div>
          )}
          {task.startedAt && (
            <div>
              <strong>Started:</strong> {formatTime(task.startedAt)}
            </div>
          )}
          {task.endedAt && (
            <div>
              <strong>Ended:</strong> {formatTime(task.endedAt)}
            </div>
          )}
          {task.failure && (
            <div style={{ marginTop: 8, color: "var(--color-warn, #d97706)" }}>
              <strong>Failure:</strong> {task.failure.error}
              {exitCode !== undefined && exitCode !== null && <> (exit {exitCode})</>}
              {exitSignal && <> [signal {exitSignal}]</>}
            </div>
          )}
        </div>
      )}

      <div className="pills" style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          className={`pills__btn${tab === "events" ? " pills__btn--active" : ""}`}
          onClick={() => setTab("events")}
        >
          Events
        </button>
        <button
          type="button"
          className={`pills__btn${tab === "metadata" ? " pills__btn--active" : ""}`}
          onClick={() => setTab("metadata")}
        >
          Metadata
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={refreshDetail}
          disabled={loading}
          aria-label="Refresh detail"
          title="Refresh"
          style={{ marginLeft: "auto" }}
        >
          <RefreshIcon className={loading ? "spin" : undefined} />
        </button>
      </div>

      {tab === "events" && (
        <div style={{ flex: 1, overflow: "auto", minHeight: 200 }}>
          {events === null && eventsError && (
            <p className="muted">
              Events not available yet
              {eventsError ? `: ${eventsError}` : ""}.
            </p>
          )}
          {events === null && !eventsError && (
            // 404 NoEventsYet from the server — the runtime hasn't
            // produced an event log file yet (common in the first
            // seconds of a task's life, before the agent's first event).
            // The list-view auto-poll plus the detail panel's own
            // poll-while-running will surface events as they appear.
            <p className="muted">No events yet for this task.</p>
          )}
          {events !== null && events.length === 0 && <p className="muted">No events yet.</p>}
          {events !== null && events.length > 0 && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 11,
                margin: 0,
              }}
            >
              {formatEventsJsonl(events)}
            </pre>
          )}
        </div>
      )}

      {tab === "metadata" && task && (
        <div style={{ flex: 1, overflow: "auto", minHeight: 200 }}>
          <pre style={{ fontSize: 11, margin: 0 }}>
            {JSON.stringify(
              {
                instructions: task.instructions,
                metadata: task.metadata,
                result: task.result,
                failure: task.failure,
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </aside>
  );
}

// ─ helpers ─

function shortId(id: string): string {
  // Task ids are `YYYYMMDD-xxxxxxxx`. The hex tail is enough to disambiguate
  // in any reasonable list, and it fits in a narrow column.
  const dash = id.lastIndexOf("-");
  return dash >= 0 ? id.slice(dash + 1) : id;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Pretty-print an NDJSON event log payload by parsing each line and showing
 * the timestamp + type prefix on its own line. Lines that don't parse as
 * JSON are passed through verbatim so we don't lose any information. The
 * NDJSON shape itself is a Copilot-specific assumption; if a future runtime
 * publishes a non-NDJSON log this formatter will fall through to verbatim
 * passthrough and we'll add a runtime-aware renderer when needed.
 */
function formatEventsJsonl(raw: string): string {
  // Strip a leading UTF-8 BOM if present. NDJSON producers occasionally
  // emit one (text-mode writes on Windows, some logging libraries); left
  // in place it would make the first line fail JSON.parse and fall
  // through to the verbatim path, dumping the BOM marker into the
  // rendered pane.
  const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = normalized.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const ts =
        typeof obj.timestamp === "string"
          ? obj.timestamp
          : typeof obj.ts === "string"
            ? obj.ts
            : "";
      const type =
        typeof obj.type === "string"
          ? obj.type
          : typeof obj.event === "string"
            ? obj.event
            : "event";
      out.push(`${ts} [${type}] ${JSON.stringify(obj)}`);
    } catch {
      out.push(line);
    }
  }
  return out.join("\n");
}

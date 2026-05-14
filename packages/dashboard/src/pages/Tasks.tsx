import type { AgentEntry } from "@emploke/catalog";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type ActivityItem,
  deleteTask,
  dispatchTask,
  fetchTaskActivity,
  getTask,
  listRuntimes,
  listTasks,
  type ServerConfig,
  subscribeTaskActivity,
  type TaskActivity,
  type TaskRecord,
  type TaskStatus,
} from "../api";
import { PlusIcon, RefreshIcon, TrashIcon } from "../components/Icons";
import { Modal } from "../components/Modal";
import { usePollWithBackoff } from "../hooks/usePollWithBackoff";
import { serverNow } from "../serverClock";
import { formatAbsolute, formatDuration, formatRelative } from "../utils/time";

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

/**
 * Convert a preset to a millisecond cutoff. Anchored on the server's
 * approximate clock (`serverNow()` from `../serverClock`) rather than
 * local `Date.now()`, so cutoffs match what the server actually sees
 * even if the user's laptop clock has drifted.
 */
function presetToSinceMs(preset: TimePreset): number | null {
  const nowDate = serverNow();
  const nowMs = nowDate.getTime();
  switch (preset) {
    case "today": {
      const d = new Date(nowDate);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "7d":
      return nowMs - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return nowMs - 30 * 24 * 60 * 60 * 1000;
    case "all":
      return null;
  }
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

  const onDispatched = async (
    agent: string,
    brief: string,
    details: string | undefined,
    runtime: string | undefined,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const created = await dispatchTask(agent, brief, details, runtime);
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
        <Modal
          open={true}
          onClose={() => {
            setDeleteTarget(null);
            setDeletePurge(false);
          }}
          title="Delete task"
          size="default"
        >
          <div className="modal__body">
            <p>
              Delete task <code>{deleteTarget.id}</code>?
              {deleteTarget.status === "running" ? " The subprocess will be killed first." : ""}
            </p>
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0 0" }}>
              By default, the workdir is preserved on disk so you can inspect the agent's output
              (stderr, artifacts, runtime event log) after the fact.
            </p>
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                fontSize: 13,
                marginTop: 10,
              }}
            >
              <input
                type="checkbox"
                checked={deletePurge}
                onChange={(e) => setDeletePurge(e.target.checked)}
                disabled={busy}
              />
              Also remove files (cannot be undone)
            </label>
          </div>
          <div className="modal__footer">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setDeleteTarget(null);
                setDeletePurge(false);
              }}
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
              {busy ? "Deleting…" : deletePurge ? "Delete and remove files" : "Delete"}
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
 *
 * Two-row visual hierarchy:
 *   row 1: status pill · agent chip · runtime chip · — spacer — · delete
 *   row 2: brief (title-prominent) · full id (mono, muted)
 *   row 3: relative time / duration (muted)
 *
 * The `brief` IS the user-supplied task title (post-#111 refactor:
 * Copilot's auto-generated session `name` reflects the framing prompt
 * rather than the user's task, so deriving headlines from runtime
 * metadata is no longer reliable). Same vibe as GitHub Issues
 * showing "title #42" rather than "#42 with title".
 */
function TaskListItem({ task, selected, onSelect, onDelete }: TaskListItemProps) {
  const tone = STATUS_TONE[task.status];
  const isRunning = task.status === "running" || task.status === "not_started";
  const runtime =
    typeof task.metadata?.runtime === "string" ? (task.metadata.runtime as string) : null;
  const headline = task.brief;
  const tooltip = task.details ? `${task.brief}\n\n${task.details}` : task.brief;
  return (
    <li
      className={`task-list__item${selected ? " task-list__item--selected" : ""}${
        isRunning ? " task-list__item--running" : ""
      }`}
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
        <StatusBadge status={task.status} tone={tone} pulse={isRunning} />
        <button
          type="button"
          className="btn btn--ghost btn--icon task-list__item-remove"
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
      <div className="task-list__item-headline" title={tooltip}>
        {headline}
      </div>
      {/* Footer is plain muted text, not chips. Agent + runtime are
          already filterable via the page toolbar; repeating them as
          chips here added visual weight without information value
          and made narrow columns wrap badly. Showing them as inline
          muted text wraps gracefully (looks like a sentence, not a
          broken UI). The id gets its own line at the bottom because
          it's a mono token of fixed size that pairs awkwardly with
          variable-width labels. */}
      <div className="task-list__item-meta muted">
        <span title={`Agent: ${task.agent}`}>{task.agent}</span>
        {runtime && (
          <>
            <span className="task-list__sep">·</span>
            <span title={`Runtime: ${runtime}`}>{runtime}</span>
          </>
        )}
        <span className="task-list__sep">·</span>
        <TaskRelativeTime task={task} />
      </div>
      <code className="task-list__id" title={task.id}>
        {task.id}
      </code>
    </li>
  );
}

/**
 * Status badge with optional pulsing dot for "running" / "not started"
 * tasks. The pulse animates via CSS keyframes (.badge__pulse-dot) and
 * stops as soon as the task transitions to a terminal status.
 */
function StatusBadge({
  status,
  tone,
  pulse,
}: {
  status: TaskStatus;
  tone: string;
  pulse: boolean;
}) {
  return (
    <span className={`badge badge--${tone}${pulse ? " badge--with-pulse" : ""}`}>
      {pulse && <span className="badge__pulse-dot" aria-hidden="true" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Smart relative-time line for a task row. Shows the most informative
 * timestamp for each lifecycle stage:
 *   - not_started: "queued 2m ago"
 *   - running: "running for 1m 23s"  (live elapsed)
 *   - terminal: "ran 5m 12s · ended 2h ago"
 * Tooltip carries the absolute timestamp for forensic precision.
 */
function TaskRelativeTime({ task }: { task: TaskRecord }) {
  if (task.status === "not_started") {
    return (
      <span className="muted" title={formatAbsolute(task.createdAt)}>
        queued {formatRelative(task.createdAt)}
      </span>
    );
  }
  if (task.status === "running" && task.startedAt) {
    return (
      <span className="muted" title={formatAbsolute(task.startedAt)}>
        running for {formatDuration(task.startedAt, null)}
      </span>
    );
  }
  if (task.endedAt && task.startedAt) {
    return (
      <span className="muted" title={formatAbsolute(task.endedAt)}>
        ran {formatDuration(task.startedAt, task.endedAt)} · ended {formatRelative(task.endedAt)}
      </span>
    );
  }
  return (
    <span className="muted" title={formatAbsolute(task.createdAt)}>
      created {formatRelative(task.createdAt)}
    </span>
  );
}

interface DispatchModalProps {
  open: boolean;
  agents: AgentEntry[];
  runtimes: string[];
  busy: boolean;
  /** Pre-fill values from a previous task ("re-run"). null = blank form. */
  prefill: TaskRecord | null;
  onClose: () => void;
  onDispatch: (
    agent: string,
    brief: string,
    details: string | undefined,
    runtime: string | undefined,
  ) => void;
}

const BRIEF_MAX_LENGTH = 200;

function DispatchModal({
  open,
  agents,
  runtimes,
  busy,
  prefill,
  onClose,
  onDispatch,
}: DispatchModalProps) {
  const [agent, setAgent] = useState<string>("");
  const [runtime, setRuntime] = useState<string>("");
  const [brief, setBrief] = useState("");
  const [details, setDetails] = useState("");

  // Reset form on open. When `prefill` is set we seed from the source
  // task — useful for re-dispatching a failed task with the same params
  // (or with a small tweak before submitting). Otherwise we start blank
  // with the catalog's first ready agent.
  useEffect(() => {
    if (!open) return;
    if (prefill) {
      setAgent(prefill.agent);
      const prefRuntime =
        typeof prefill.metadata?.runtime === "string"
          ? (prefill.metadata.runtime as string)
          : (runtimes[0] ?? "");
      setRuntime(prefRuntime);
      setBrief(prefill.brief);
      setDetails(prefill.details ?? "");
    } else {
      setAgent(agents[0]?.agent.fqn ?? "");
      setRuntime(runtimes[0] ?? "");
      setBrief("");
      setDetails("");
    }
  }, [open, agents, runtimes, prefill]);

  const briefTrimmed = brief.trim();
  const briefValid =
    briefTrimmed.length > 0 &&
    briefTrimmed.length <= BRIEF_MAX_LENGTH &&
    !briefTrimmed.includes("\n") &&
    !briefTrimmed.includes("\r");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent || !briefValid) return;
    const detailsTrimmed = details.trim();
    onDispatch(
      agent,
      briefTrimmed,
      detailsTrimmed.length > 0 ? details : undefined,
      runtime || undefined,
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={prefill ? "Re-run task" : "Dispatch task"}
      size="default"
    >
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
                <option key={a.agent.fqn} value={a.agent.fqn}>
                  {a.agent.fqn}
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
          <label htmlFor="task-brief">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Brief
            </div>
            <input
              id="task-brief"
              className="input"
              type="text"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Single-line task title (≤ 200 chars)"
              maxLength={BRIEF_MAX_LENGTH}
              required
              disabled={busy}
              style={{ width: "100%", fontFamily: "inherit" }}
            />
          </label>
          <label htmlFor="task-details">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Details (optional)
            </div>
            <textarea
              id="task-details"
              className="input"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Long-form context for the agent (optional, multi-line)"
              rows={8}
              disabled={busy}
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
            disabled={busy || !agent || !briefValid}
          >
            {busy ? (prefill ? "Re-running…" : "Dispatching…") : prefill ? "Re-run" : "Dispatch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose: () => void;
  onRerun: (task: TaskRecord) => void;
  /** Auto-refresh cadence while the displayed task is running (ms). */
  pollIntervalMs: number;
}

type DetailTab = "activity" | "raw" | "metadata";

function TaskDetailPanel({ taskId, onClose, onRerun, pollIntervalMs }: TaskDetailPanelProps) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [activity, setActivity] = useState<TaskActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("activity");
  const [loading, setLoading] = useState(false);

  // Race guards mirroring the list view (see TasksPage.refresh):
  //   * `mountedRef` for the standard unmount-during-fetch case
  //   * `taskTokenRef` to drop the response when the user clicks task A
  //     then task B before A's two-step fetch (getTask + activity)
  //     completes — without this guard A's payload would land
  //     under B's header
  //   * `inFlightRef` to keep the auto-poll from stacking when a refresh
  //     outlives `pollIntervalMs` (a real risk on the detail panel
  //     because each cycle fires three serial fetches)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const taskTokenRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const loadingOlderRef = useRef(false);
  // Mirror of the activity state, kept in a ref so callbacks (notably
  // loadOlderActivity, which can fire from IntersectionObserver any
  // time) read the latest seq window without re-creating their closure
  // on every state change. setState updaters are async, so the
  // earlier "snapshot via setState((prev) => prev)" trick raced the
  // first IntersectionObserver fire and bailed early — leaving the
  // sentinel stuck in view, never re-firing because IO only triggers
  // on intersection state CHANGES.
  const activityRef = useRef<TaskActivity | null>(null);

  /**
   * Prepend the previous page of activity items. Called when the user
   * scrolls to the TOP of the timeline (top sentinel intersects).
   * Reads the oldest currently-loaded seq from `activityRef` and asks
   * for the page immediately preceding it.
   *
   * No-ops when there's no older page (oldest seq already 0) or when
   * a page fetch is already in flight. Errors are surfaced via the
   * existing activityError channel.
   *
   * Important: the `StickToBottomScroll` parent ignores prepends (its
   * `followKey` tracks the LAST item's seq, not the count) so the
   * user's reading position is preserved automatically. The scroll
   * anchor compensation (keep the user's viewport content stable
   * after the list grows at the top) lives in the sentinel
   * component below — see `LoadOlderSentinel`.
   */
  const loadOlderActivity = useCallback(async (): Promise<void> => {
    if (!taskId) return;
    if (loadingOlderRef.current) return;
    const a = activityRef.current;
    if (a === null || a.activity.length === 0) return;
    const oldestSeq = a.activity[0]?.seq;
    if (oldestSeq === undefined || oldestSeq <= 0) return;
    loadingOlderRef.current = true;
    try {
      const next = await fetchTaskActivity(taskId, { before: oldestSeq, limit: 50 });
      if (!mountedRef.current) return;
      if (next === null) return;
      setActivity((prev) => {
        if (prev === null) return next;
        // Merge by seq (last-write-wins for any overlap, though there
        // shouldn't be any since the new page is strictly older).
        const bySeq = new Map<number, ActivityItem>();
        for (const it of next.activity) bySeq.set(it.seq, it);
        for (const it of prev.activity) bySeq.set(it.seq, it);
        const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
        return {
          activity: merged,
          // Existing headline result wins (it's from the tail and
          // always newer than anything we'd find by scrolling up).
          result: prev.result ?? next.result,
          // totalItems is authoritative for the WHOLE log, so the
          // server tells us the same value either way; prefer the
          // freshest (might increase between calls if the task is
          // still running).
          totalItems: next.totalItems ?? prev.totalItems,
          // Truncation marker on the prepended page is about the
          // raw-read tail cap, which doesn't apply here — the older
          // page that we successfully fetched is, by definition, not
          // the one that hit the cap. Keep whichever the existing
          // state has.
          ...(prev.truncated !== undefined ? { truncated: prev.truncated } : {}),
        };
      });
    } catch (e) {
      if (!mountedRef.current) return;
      setActivityError((e as Error).message);
    } finally {
      loadingOlderRef.current = false;
    }
  }, [taskId]);

  // Keep the ref synced with the latest activity state so
  // loadOlderActivity can read the current oldest seq without taking
  // `activity` as a dep (which would re-create the callback on every
  // SSE tick and thrash IntersectionObserver).
  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  // Tab is plain state — no need for a ref since `refreshDetail` no
  // longer branches on which tab is active (the Raw tab now renders
  // the same `activity` payload as JSON).
  const refreshDetail = useCallback(async () => {
    if (!taskId) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const token = taskId;
    taskTokenRef.current = token;
    setLoading(true);
    try {
      // Always fetch:
      //   - task metadata (cheap; drives status badge, header, result fallback)
      //   - activity timeline tail (small parsed JSON; drives Activity
      //     tab, Result panel, AND the Raw tab — which now just renders
      //     the activity payload as JSON, no separate request needed)
      //
      // On poll re-fetches we use forward-pagination from the
      // currently-known last seq when possible — much cheaper than
      // re-fetching the full tail every cycle. First load always
      // fetches the latest 50 (no `after` set).
      const known = activityRef.current;
      const lastSeq =
        known !== null && known.activity.length > 0
          ? known.activity[known.activity.length - 1]?.seq
          : undefined;
      await Promise.all([
        getTask(taskId).then((t) => {
          if (!mountedRef.current || token !== taskTokenRef.current) return;
          setTask(t);
        }),
        fetchTaskActivity(taskId, lastSeq !== undefined ? { after: lastSeq } : { limit: 50 })
          .then((a) => {
            if (!mountedRef.current || token !== taskTokenRef.current) return;
            if (a === null) {
              setActivity(null);
              setActivityError(null);
              return;
            }
            // Forward fetch: merge into existing state. Initial fetch
            // (`lastSeq === undefined`): replace.
            if (lastSeq === undefined) {
              setActivity(a);
            } else {
              setActivity((prev) => {
                if (prev === null) return a;
                const bySeq = new Map<number, ActivityItem>();
                for (const it of prev.activity) bySeq.set(it.seq, it);
                for (const it of a.activity) bySeq.set(it.seq, it);
                const merged = Array.from(bySeq.values()).sort((x, y) => x.seq - y.seq);
                return {
                  activity: merged,
                  result: a.result ?? prev.result,
                  totalItems: a.totalItems ?? prev.totalItems,
                  ...(a.truncated !== undefined ? { truncated: a.truncated } : {}),
                };
              });
            }
            setActivityError(null);
          })
          .catch((e) => {
            if (!mountedRef.current || token !== taskTokenRef.current) return;
            setActivityError((e as Error).message);
          }),
      ]);
    } catch (e) {
      if (!mountedRef.current || token !== taskTokenRef.current) return;
      setTask(null);
      setActivityError((e as Error).message);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && token === taskTokenRef.current) {
        setLoading(false);
      }
    }
  }, [taskId]);

  useEffect(() => {
    // Always reset the per-task fetched state when the URL switches
    // tasks. Without this, switching from task A to task B leaves A's
    // activity in state and the next render shows A's payload under B's
    // header until the new fetch resolves. The ref must be cleared
    // synchronously so refreshDetail (called below) doesn't see the
    // previous task's last-seq and issue an `?after=N` against the new
    // task — setActivity(null) is async and the syncing useEffect runs
    // a render later.
    setTask(null);
    setActivity(null);
    activityRef.current = null;
    setActivityError(null);
    if (!taskId) return;
    void refreshDetail();
  }, [taskId, refreshDetail]);

  // Auto-poll while running so the runtime's event log + status update
  // without a manual refresh click. Cadence comes from the parent (which
  // sources it from /api/config) so list view and detail view stay in
  // sync. Backoff matches the list-view loop above.
  const detailPollEnabled = !!task && (task.status === "running" || task.status === "not_started");
  usePollWithBackoff(refreshDetail, pollIntervalMs, detailPollEnabled);

  // Live tail via SSE while the task is running. The poll above keeps
  // the task header (status, exit fields) up to date — the SSE stream
  // delivers individual ActivityItems as they're produced, so the
  // timeline updates in near-real-time without burning the polling
  // budget. Items are merged by `seq` (last-write-wins) so a
  // tool_call's "running" -> "success" transition (same seq, updated
  // status) renders correctly. On terminal status the subscription
  // closes itself; we also tear down on task switch / unmount.
  useEffect(() => {
    if (!taskId || !detailPollEnabled) return;
    const handle = subscribeTaskActivity(taskId, {
      onItem: (item) => {
        if (!mountedRef.current) return;
        setActivity((prev) => {
          // Merge by seq; new items append, existing seqs overwrite (handles
          // tool_call begin -> end mutation that yields the same seq twice).
          const bySeq = new Map<number, ActivityItem>();
          if (prev !== null) {
            for (const it of prev.activity) bySeq.set(it.seq, it);
          }
          bySeq.set(item.seq, item);
          const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
          return prev !== null
            ? {
                ...prev,
                activity: merged,
                // Live tail items are by definition extending the
                // total so we update totalItems to stay >= max(seq+1).
                totalItems: Math.max(prev.totalItems, item.seq + 1),
              }
            : {
                activity: merged,
                result: null,
                // Best-effort bootstrap when the very first thing we
                // see is an SSE item (no prior REST snapshot). The next
                // REST poll will replace this with the authoritative
                // server count.
                totalItems: item.seq + 1,
              };
        });
      },
      onError: (err) => {
        // Soft error: the EventSource auto-reconnects; we just log
        // for visibility. A persistent error surfaces via the polling
        // path's activityError state when the next refreshDetail runs.
        if (typeof console !== "undefined") {
          console.warn("activity stream error", err);
        }
      },
    });
    return () => handle.close();
  }, [taskId, detailPollEnabled]);

  // Result is the agent's final answer. Two rules:
  //
  //  1. **Only when actually finished successfully.** Earlier the panel
  //     surfaced `activity.result` (= last assistant message in the log)
  //     unconditionally, so during a running task the most recent
  //     intermediate thought showed up as if it were the headline. We
  //     gate on `status === "success"` so Result only ever reflects a
  //     real completion. Failures route through the dedicated Failure
  //     alert in the header; cancelled / running tasks show no Result
  //     at all.
  //
  //  2. **Truncate long results.** Real Copilot results vary from one
  //     line to ~50 lines. Without a cap a long result would push the
  //     activity timeline below the fold. We default to ~600 chars
  //     ("Show more" reveals the rest); below that threshold the
  //     control is omitted entirely so short results render cleanly.
  //
  // Computed up here so `useState` for the expand toggle stays at the
  // top of the hook order.
  const headlineResult =
    task?.status === "success"
      ? (activity?.result ??
        (typeof task?.result?.output === "string" && task.result.output.length > 0
          ? task.result.output
          : null))
      : null;

  // Common box styling lives in CSS now. The right panel anchors at
  // the top of its grid cell (.tasks-pane__detail), with its own
  // scroll container and a viewport-capped max-height so the page
  // never grows scrollbars regardless of event-log size.
  if (!taskId) {
    return (
      <aside className="tasks-pane__detail tasks-pane__detail--empty">
        <p className="muted" style={{ margin: 0 }}>
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
  // The user-supplied `brief` is the canonical task title (post-#111
  // refactor). Lead the panel with it; fall back to the task id only
  // while the task object hasn't loaded yet.
  const title = task?.brief ?? null;
  const isRunning = task && (task.status === "running" || task.status === "not_started");

  return (
    <aside className="tasks-pane__detail">
      <header className="task-detail__head">
        {title && <h2 className="task-detail__title">{title}</h2>}
        <div className="task-detail__head-row">
          <code className="task-detail__id" title={taskId}>
            {taskId}
          </code>
          {task && (
            <StatusBadge
              status={task.status}
              tone={STATUS_TONE[task.status]}
              pulse={isRunning ?? false}
            />
          )}
          <span className="task-detail__head-spacer" />
          {task && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onRerun(task)}
              title="Re-dispatch with the same agent + brief + details"
            >
              Re-run
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={refreshDetail}
            disabled={loading}
            aria-label="Refresh detail"
            title="Refresh"
          >
            <RefreshIcon className={loading ? "spin" : undefined} />
          </button>
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
          <div className="task-detail__statbar">
            <span title={`Agent: ${task.agent}`}>
              <span className="task-detail__statbar-key">Agent</span> {task.agent}
            </span>
            {runtime && (
              <span title={`Runtime: ${runtime}`}>
                <span className="task-detail__statbar-key">Runtime</span> {runtime}
              </span>
            )}
            {task.startedAt && (
              <span title={formatAbsolute(task.startedAt)}>
                <span className="task-detail__statbar-key">Started</span>{" "}
                {formatRelative(task.startedAt)}
              </span>
            )}
            {(task.endedAt || isRunning) && task.startedAt && (
              <span
                title={
                  task.endedAt
                    ? `Ended ${formatAbsolute(task.endedAt)}`
                    : "Running, elapsed up to now"
                }
              >
                <span className="task-detail__statbar-key">
                  {task.endedAt ? "Duration" : "Elapsed"}
                </span>{" "}
                {formatDuration(task.startedAt, task.endedAt ?? null)}
              </span>
            )}
          </div>
        )}
        {task?.details && <TaskDetails text={task.details} />}
        {task?.failure && (
          <div className="alert alert--error" style={{ margin: 0 }}>
            <strong>Failure:</strong> {task.failure.error}
            {exitCode !== undefined && exitCode !== null && <> (exit {exitCode})</>}
            {exitSignal && <> [signal {exitSignal}]</>}
          </div>
        )}
      </header>

      {headlineResult !== null && <ResultSection text={headlineResult} />}

      <nav className="pills" style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          className={`pills__btn${tab === "activity" ? " pills__btn--active" : ""}`}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
        <button
          type="button"
          className={`pills__btn${tab === "raw" ? " pills__btn--active" : ""}`}
          onClick={() => setTab("raw")}
          title="Same activity payload as the Activity tab, rendered as raw JSON for debugging"
        >
          Raw JSON
        </button>
        <button
          type="button"
          className={`pills__btn${tab === "metadata" ? " pills__btn--active" : ""}`}
          onClick={() => setTab("metadata")}
        >
          Metadata
        </button>
      </nav>

      {tab === "activity" && (
        <StickToBottomScroll
          className="task-detail__body"
          // Reset on task switch so the new task lands at the bottom.
          resetKey={taskId ?? ""}
          // Follow only when a NEW tail event arrives. Using
          // `length` would also fire on `LoadOlderSentinel` prepends,
          // which would yank the user back to the bottom while
          // they're scrolling up to read history — exactly the
          // anti-pattern we're trying to avoid. The `seq` of the
          // last item is monotonic per task and only changes when
          // the runtime emits a new event.
          followKey={activity?.activity[activity.activity.length - 1]?.seq ?? 0}
          // Top-anchor: when the FIRST item's seq decreases (older
          // history was prepended), preserve the user's reading
          // position by adjusting scrollTop by the prepended block's
          // height. Without this the content under the user's eyes
          // would shift down by exactly the prepended height.
          topAnchorKey={activity?.activity[0]?.seq ?? 0}
        >
          <ActivityView
            activity={activity}
            activityError={activityError}
            onLoadOlder={loadOlderActivity}
          />
        </StickToBottomScroll>
      )}

      {tab === "raw" && (
        <div className="task-detail__body">
          {activity === null && activityError && (
            <p className="muted">
              Activity not available yet
              {activityError ? `: ${activityError}` : ""}.
            </p>
          )}
          {activity === null && !activityError && (
            // 404 NoEventsYet from the server — the runtime hasn't
            // produced any activity yet (common in the first seconds
            // of a task's life, before the agent's first event). The
            // poll-while-running loop will surface activity as it
            // appears.
            <p className="muted">No activity yet for this task.</p>
          )}
          {activity !== null && (
            <pre className="task-detail__events">{JSON.stringify(activity, null, 2)}</pre>
          )}
        </div>
      )}

      {tab === "metadata" && task && (
        <div className="task-detail__body">
          <pre className="task-detail__events">
            {JSON.stringify(
              {
                brief: task.brief,
                ...(task.details !== undefined ? { details: task.details } : {}),
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

/**
 * Scroll container that follows the bottom of its content while the
 * user has scrolled to (or near) the bottom — matches how chat apps
 * (Slack, Cursor agent, browser DevTools console) keep the latest
 * line visible during live activity, without yanking the user's
 * position when they've scrolled up to read history.
 *
 * Three effects:
 *
 * 1. **Reset effect** (keyed by `resetKey`): when the user switches
 *    tasks, jump to the bottom unconditionally so the latest events
 *    are visible right away. Also resets `stickToBottom = true` so
 *    follow-on poll updates keep tracking.
 * 2. **Follow effect** (keyed by `followKey`): each time the
 *    activity event count changes, if the user is currently pinned
 *    to the bottom, scroll the new content into view. If they've
 *    scrolled up, leave their viewport position alone — the new
 *    item appended below moves the scrollbar thumb up visually,
 *    but the content the user was reading stays in place.
 * 3. **Top-anchor effect** (keyed by `topAnchorKey`): when older
 *    history is prepended (the first item's seq decreases), the
 *    naive behavior is to keep `scrollTop` constant — but the
 *    content the user was reading shifts DOWN by the height of the
 *    prepended block. We compensate by adding `(newScrollHeight -
 *    oldScrollHeight)` to `scrollTop`, which preserves the user's
 *    reading position. Only runs when the user has scrolled away
 *    from the bottom (otherwise the follow effect handles it).
 *
 * `useLayoutEffect` (rather than `useEffect`) avoids the visible
 * one-frame jump that would otherwise show the un-scrolled state
 * before the autoscroll runs.
 *
 * The bottom-detection has a 4px tolerance for subpixel rounding
 * — without it, a freshly-appended item can take the user "out of
 * the bottom zone" by exactly the new item's height, breaking the
 * follow loop after a single update.
 */
function StickToBottomScroll({
  className,
  resetKey,
  followKey,
  topAnchorKey,
  children,
}: {
  className?: string;
  /** Changes → unconditional jump to bottom (e.g. task switch). */
  resetKey: string | number;
  /** Changes → scroll to bottom only if user was at bottom. */
  followKey: string | number;
  /**
   * Changes → preserve reading position when content was prepended.
   * Should be the seq (or unique key) of the FIRST item in the list.
   * When this number decreases, we know a prepend happened and we
   * adjust `scrollTop` by the height delta. Optional: when omitted,
   * scroll-anchor behavior is disabled.
   */
  topAnchorKey?: string | number;
  children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const isAtBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isAtBottom(el);
  }, [isAtBottom]);

  // Reset on resetKey change — task switch jumps to bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger; the body intentionally only reads the ref.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
  }, [resetKey]);

  // Follow on followKey change — new events scroll into view if user
  // was pinned to the bottom; otherwise leave their position alone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: followKey is the trigger; the body intentionally only reads the ref.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [followKey]);

  // Top-anchor effect — preserve reading position on prepend.
  //
  // We track the previous topAnchorKey + scrollHeight in refs so the
  // next render can compute the delta. The first render initializes
  // the refs and skips adjustment (no prior measurement to compare
  // against). A "prepend" is detected when the topAnchorKey changes
  // AND, if both old and new are numbers, the new value is smaller
  // (older items have lower seq) — this rules out the "task switched
  // to a different first-item" case (handled by resetKey).
  const prevScrollHeightRef = useRef(0);
  const prevTopAnchorRef = useRef<string | number | undefined>(topAnchorKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: topAnchorKey is the trigger; refs are intentionally read inside.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevKey = prevTopAnchorRef.current;
    const prevHeight = prevScrollHeightRef.current;
    if (
      topAnchorKey !== undefined &&
      prevKey !== undefined &&
      prevKey !== topAnchorKey &&
      typeof prevKey === "number" &&
      typeof topAnchorKey === "number" &&
      topAnchorKey < prevKey &&
      prevHeight > 0 &&
      !stickToBottomRef.current
    ) {
      const delta = el.scrollHeight - prevHeight;
      if (delta > 0) {
        el.scrollTop += delta;
      }
    }
    prevTopAnchorRef.current = topAnchorKey;
    prevScrollHeightRef.current = el.scrollHeight;
  }, [topAnchorKey]);

  return (
    <div ref={scrollRef} className={className} onScroll={onScroll}>
      {children}
    </div>
  );
}

/**
 * Activity tab — runtime-neutral timeline of user / assistant /
 * summary entries. The runtime is responsible for filtering out the
 * low-signal events (handshake, model preference, system prompts);
 * what arrives here is only the things a person reads.
 *
 * Rendered as an ordered list with role-coded headers and content
 * bodies. Tool calls inside an assistant turn render as a small chip
 * row underneath the message text.
 */
function ActivityView({
  activity,
  activityError,
  onLoadOlder,
}: {
  activity: TaskActivity | null;
  activityError: string | null;
  onLoadOlder: () => Promise<void>;
}) {
  if (activity === null) {
    if (activityError) {
      return (
        <p className="muted">
          Activity not available
          {activityError ? `: ${activityError}` : ""}.
        </p>
      );
    }
    return <p className="muted">No activity yet.</p>;
  }
  if (activity.activity.length === 0) {
    return <p className="muted">No activity yet for this task.</p>;
  }
  // Older history is available iff the oldest currently-loaded item is
  // not seq 0 (i.e. there exist seqs lower than what we have). The
  // sentinel renders ABOVE the list so when the user scrolls UP
  // towards history, intersection fires and we load the previous page.
  const oldestSeq = activity.activity[0]?.seq ?? 0;
  const hasOlder = oldestSeq > 0;
  return (
    <>
      {activity.truncated !== undefined && activity.truncated.reason === "size_limit" && (
        <div
          className="muted"
          style={{
            fontSize: 12,
            padding: "6px 10px",
            marginBottom: 8,
            background: "rgba(210, 153, 34, 0.08)",
            border: "1px solid rgba(210, 153, 34, 0.2)",
            borderRadius: 4,
          }}
        >
          Showing the tail of a very large event log
          {activity.truncated.droppedBytes !== undefined &&
            ` (${(activity.truncated.droppedBytes / (1024 * 1024)).toFixed(1)} MB dropped)`}
          . Older events were skipped to keep the page responsive.
        </div>
      )}
      {hasOlder && (
        <LoadOlderSentinel onIntersect={onLoadOlder} activity={activity} oldestSeq={oldestSeq} />
      )}
      <ol className="activity-list">
        {activity.activity.map((item) => (
          // `seq` is monotonic per task and unique within the timeline,
          // so it's a stable React key across re-renders (incl. SSE
          // updates that mutate a tool_call's status with the same seq).
          <ActivityRow key={item.seq} item={item} />
        ))}
      </ol>
    </>
  );
}

/**
 * Top-of-list sentinel that triggers the previous page fetch when
 * scrolled into view. Uses IntersectionObserver with a generous
 * rootMargin so the previous page starts loading slightly before
 * the user actually reaches the top (smoother UX than waiting for
 * the spinner to appear).
 *
 * Re-observes when `oldestSeq` changes — this fires the next
 * older-page after the current one is prepended (in case the
 * sentinel is still in view because the new page didn't fill
 * the viewport).
 */
function LoadOlderSentinel({
  onIntersect,
  activity,
  oldestSeq,
}: {
  onIntersect: () => Promise<void>;
  activity: TaskActivity;
  oldestSeq: number;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    // Reference oldestSeq in the body so the dep list isn't "extra".
    void oldestSeq;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void onIntersect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onIntersect, oldestSeq]);
  return (
    <div
      ref={sentinelRef}
      className="muted"
      style={{ padding: "10px 0", textAlign: "center", fontSize: 12 }}
    >
      Loading older history ({activity.activity.length} of {activity.totalItems})…
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  if (item.kind === "summary") {
    const stats = item.stats;
    const tokens = item.tokens;
    const codeChanged =
      stats !== undefined &&
      ((stats.linesAdded ?? 0) > 0 ||
        (stats.linesRemoved ?? 0) > 0 ||
        (stats.filesModified?.length ?? 0) > 0);
    return (
      <li className="activity-row activity-row--summary">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--summary">Summary</span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
          </time>
        </div>
        {item.text !== undefined && item.text.length > 0 && (
          <p className="activity-row__body">{item.text}</p>
        )}
        <div className="activity-row__summary-grid">
          {codeChanged ? (
            <span>
              <strong>Code:</strong> +{stats?.linesAdded ?? 0} −{stats?.linesRemoved ?? 0} across{" "}
              {stats?.filesModified?.length ?? 0} file
              {(stats?.filesModified?.length ?? 0) === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="muted">No code changes</span>
          )}
          {(stats?.premiumRequests ?? 0) > 0 && (
            <span>
              <strong>Premium requests:</strong> {stats?.premiumRequests}
            </span>
          )}
          {tokens !== undefined && ((tokens.input ?? 0) > 0 || tokens.output > 0) && (
            <span>
              <strong>Tokens:</strong>{" "}
              {tokens.input !== undefined ? (
                <>
                  {tokens.input.toLocaleString()} in
                  {/*
                    Show cache-hit % when the upstream provided cacheRead
                    accounting. On long Claude sessions this is usually 90%+
                    and dramatically changes the cost story (cache reads
                    bill at ~1/10 fresh input).
                  */}
                  {tokens.cached !== undefined && tokens.input > 0 && (
                    <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                      ({Math.round((tokens.cached / tokens.input) * 100)}% cached)
                    </span>
                  )}
                  {" / "}
                </>
              ) : null}
              {tokens.output.toLocaleString()} out
              {tokens.reasoning !== undefined && tokens.reasoning > 0 && (
                <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                  (incl. {tokens.reasoning.toLocaleString()} reasoning)
                </span>
              )}
            </span>
          )}
          {stats?.costUSD !== undefined && (
            <span>
              <strong>Cost:</strong> ${stats.costUSD.toFixed(4)}
            </span>
          )}
          {stats?.model && (
            <span>
              <strong>Model:</strong> {stats.model}
            </span>
          )}
        </div>
      </li>
    );
  }

  if (item.kind === "thinking") {
    return (
      <li className="activity-row activity-row--thinking">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--thinking">
            Thinking{item.subject ? `: ${item.subject}` : ""}
          </span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
          </time>
        </div>
        {/*
          Open by default — Copilot's reasoning traces are typically 1-3
          sentences and useful at a glance; collapsing them would force a
          click for every turn. The <details> is kept (rather than just
          rendering the body inline) so power users can still hide noisy
          extended-thinking output on long sessions.
        */}
        <details open>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
            Reasoning
          </summary>
          <p className="activity-row__body" style={{ fontStyle: "italic", opacity: 0.8 }}>
            {item.text}
          </p>
        </details>
      </li>
    );
  }

  if (item.kind === "tool_call") {
    const statusColor =
      item.status === "success"
        ? "#3fb950"
        : item.status === "error"
          ? "#f85149"
          : item.status === "cancelled"
            ? "#8b949e"
            : "#d29922";
    return (
      <li className="activity-row activity-row--tool_call">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--tool_call">
            <span style={{ color: statusColor }}>●</span> tool: {item.name}
          </span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
            {item.durationMs !== undefined && ` (${item.durationMs}ms)`}
          </time>
        </div>
        {item.args !== undefined && (
          <details>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
              Arguments
            </summary>
            <pre className="activity-row__pre">{JSON.stringify(item.args, null, 2)}</pre>
          </details>
        )}
        {item.display !== undefined ? (
          <ToolDisplay content={item.display.content} />
        ) : (
          item.result !== undefined && (
            <details>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
                Result
              </summary>
              <pre className="activity-row__pre">
                {typeof item.result === "string"
                  ? item.result
                  : JSON.stringify(item.result, null, 2)}
              </pre>
            </details>
          )
        )}
      </li>
    );
  }

  if (item.kind === "system") {
    const levelColor =
      item.level === "error" ? "#f85149" : item.level === "warn" ? "#d29922" : "#8b949e";
    return (
      <li className="activity-row activity-row--system">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--system">
            <span style={{ color: levelColor }}>●</span> {item.subKind ?? "system"}
          </span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
          </time>
        </div>
        <p className="activity-row__body muted" style={{ fontSize: 12 }}>
          {item.text}
        </p>
      </li>
    );
  }

  // user / assistant
  return (
    <li className={`activity-row activity-row--${item.kind}`}>
      <div className="activity-row__head">
        <span className={`activity-row__role activity-row__role--${item.kind}`}>
          {item.kind === "user" ? "User" : "Assistant"}
          {item.kind === "assistant" && item.model !== undefined && (
            <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
              ({item.model})
            </span>
          )}
        </span>
        <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
          {formatRelative(item.timestamp)}
          {item.kind === "assistant" && item.tokens !== undefined && (
            <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
              ({item.tokens.output.toLocaleString()} tok)
            </span>
          )}
        </time>
      </div>
      {item.text.length > 0 && <p className="activity-row__body">{item.text}</p>}
      {item.kind === "user" && item.attachments !== undefined && item.attachments.length > 0 && (
        <div
          className="activity-row__attachments"
          style={{ display: "flex", gap: 6, marginTop: 4 }}
        >
          {item.attachments.map((att) => (
            <span
              key={att.url ?? att.data ?? att.name ?? Math.random()}
              className="activity-row__tool"
              title={att.mimeType ?? att.kind}
            >
              📎 {att.name ?? att.kind}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * Renders a tool's display.content (Copilot's `result.content`,
 * Gemini's `resultDisplay`). Short results show inline; long ones
 * collapse to a one-line preview behind a "Show full result"
 * toggle. The threshold is a soft preview cap — the bounded
 * `.activity-row__pre` style provides a vertical scroll backstop
 * regardless.
 *
 * Toggle uses the same button + state pattern as `ResultSection` /
 * `TaskInstructions` rather than `<details>/<summary>`: the latter
 * forces the summary to stay on screen, so opening the disclosure
 * would render BOTH the preview and the full content at once.
 */
const TOOL_DISPLAY_PREVIEW_CHARS = 240;
function ToolDisplay({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const isLong = content.length > TOOL_DISPLAY_PREVIEW_CHARS;
  if (!isLong) {
    return (
      <p className="activity-row__body" style={{ fontSize: 12 }}>
        {content}
      </p>
    );
  }
  // First-line preview when content is multiline; otherwise the
  // first N chars. Either way, the bounded pre handles overflow
  // when the user expands.
  const previewSrc = content.split("\n", 1)[0] ?? content;
  const preview =
    previewSrc.length > TOOL_DISPLAY_PREVIEW_CHARS
      ? `${previewSrc.slice(0, TOOL_DISPLAY_PREVIEW_CHARS)}…`
      : previewSrc;
  return (
    <div>
      {expanded ? (
        <pre id={bodyId} className="activity-row__pre">
          {content}
        </pre>
      ) : (
        <p id={bodyId} className="activity-row__body" style={{ fontSize: 12 }}>
          {preview}
        </p>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        style={{
          marginTop: 4,
          background: "none",
          border: "none",
          color: "var(--color-link, #58a6ff)",
          cursor: "pointer",
          padding: 0,
          fontSize: 11,
        }}
      >
        {expanded ? "Show less" : `Show full (${content.length.toLocaleString()} chars)`}
      </button>
    </div>
  );
}

// ─ helpers ─

/**
 * Detail-header body with collapse-by-default for long task details.
 * Short bodies render plain (the existing 4-line CSS clamp is enough);
 * long ones use a button + state toggle so the user can expand to read
 * the full text without the header eating half the viewport.
 *
 * Toggle uses the same button + state pattern as `ResultSection` /
 * `ToolDisplay` rather than `<details>/<summary>`: the latter
 * forces the summary to stay on screen, so opening the disclosure
 * would render BOTH the preview and the full content at once.
 *
 * The brief above already serves as the task's persistent title;
 * `details` is the optional long-form body the user authored at
 * dispatch time. See the comment in TaskDetail's render.
 */
const TASK_DETAILS_PREVIEW_CHARS = 320;
function TaskDetails({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const isLong = text.length > TASK_DETAILS_PREVIEW_CHARS;
  if (!isLong) {
    return (
      <p className="task-detail__details" title={text}>
        {text}
      </p>
    );
  }
  // Cut on a word boundary near the threshold for a cleaner preview.
  const cut = text.lastIndexOf(" ", TASK_DETAILS_PREVIEW_CHARS);
  const preview = `${text.slice(0, cut > 0 ? cut : TASK_DETAILS_PREVIEW_CHARS)}…`;
  return (
    <div>
      {expanded ? (
        <p
          id={bodyId}
          className="task-detail__details"
          title={text}
          style={{ WebkitLineClamp: "unset", maxHeight: 320, overflowY: "auto" }}
        >
          {text}
        </p>
      ) : (
        <p id={bodyId} className="task-detail__details" title={text}>
          {preview}
        </p>
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        style={{
          marginTop: 4,
          background: "none",
          border: "none",
          color: "var(--color-link, #58a6ff)",
          cursor: "pointer",
          padding: 0,
          fontSize: 11,
        }}
      >
        {expanded ? "Show less" : `Show full (${text.length.toLocaleString()} chars)`}
      </button>
    </div>
  );
}

/**
 * Result section under the task header. Two visual states:
 *   - **collapsed**: word-bounded preview (~{@link RESULT_PREVIEW_CHARS}
 *     chars) + a "Show more" button. Rendered for results longer than
 *     the threshold; short results skip the toggle entirely.
 *   - **expanded**: full text + "Show less" button. The preview text
 *     is gone — only one state is visible at a time, unlike the
 *     `<details>`/`<summary>` element which forces the summary to stay
 *     on screen and ends up rendering BOTH preview and full content
 *     simultaneously.
 *
 * Cap chosen empirically from real Copilot session data: median final
 * answer ~1 KB / 15 lines, max ~4.8 KB / 54 lines; 600 chars (~10 lines
 * of typical text) keeps short answers inline and reins in the long
 * ones with one click. Expanded body is capped to 480px scroll so even
 * a 4 KB result can't push the activity timeline below the fold.
 */
const RESULT_PREVIEW_CHARS = 600;
function ResultSection({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // ARIA disclosure pattern: button toggles a sibling region; the region's
  // id is referenced by the button's `aria-controls` so screen readers can
  // associate them. `useId` (React 19) gives a stable, collision-free id.
  const bodyId = useId();
  const isLong = text.length > RESULT_PREVIEW_CHARS;
  if (!isLong) {
    return (
      <section className="task-detail__result">
        <h3 className="task-detail__section-title">Result</h3>
        <p className="task-detail__result-body">{text}</p>
      </section>
    );
  }
  // Cut on a word boundary near the threshold for a cleaner preview.
  const cut = text.lastIndexOf(" ", RESULT_PREVIEW_CHARS);
  const preview = `${text.slice(0, cut > 0 ? cut : RESULT_PREVIEW_CHARS)}…`;
  return (
    <section className="task-detail__result">
      <h3 className="task-detail__section-title">Result</h3>
      {expanded ? (
        <p
          id={bodyId}
          className="task-detail__result-body"
          style={{ maxHeight: 480, overflowY: "auto" }}
        >
          {text}
        </p>
      ) : (
        <p id={bodyId} className="task-detail__result-body">
          {preview}
        </p>
      )}
      <button
        type="button"
        className="link-button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        style={{
          marginTop: 6,
          background: "none",
          border: "none",
          color: "var(--color-link, #58a6ff)",
          cursor: "pointer",
          padding: 0,
          fontSize: 12,
        }}
      >
        {expanded ? "Show less" : `Show full (${text.length.toLocaleString()} chars)`}
      </button>
    </section>
  );
}

import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 *   row 2: instructions (title-prominent) · full id (mono, muted)
 *   row 3: relative time / duration (muted)
 *
 * Instructions are the actual *content* of a task — the id is a
 * disambiguator, not a name. So instructions get the title role and id
 * gets relegated to the subtitle, matching how GitHub Issues shows
 * "title #42" rather than "#42 with title".
 */
function TaskListItem({ task, selected, onSelect, onDelete }: TaskListItemProps) {
  const tone = STATUS_TONE[task.status];
  const isRunning = task.status === "running" || task.status === "not_started";
  const runtime =
    typeof task.metadata?.runtime === "string" ? (task.metadata.runtime as string) : null;
  // Pull the first non-empty line of instructions as the headline.
  // Multi-line instructions usually start with the gist on line 1 and
  // expand below; rendering only the gist keeps row height predictable
  // and CSS ellipsis handles overflow.
  const headline =
    task.instructions
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? "(empty instructions)";
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
      <div className="task-list__item-headline" title={task.instructions}>
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
  onDispatch: (agent: string, instructions: string, runtime: string | undefined) => void;
}

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
  const [instructions, setInstructions] = useState("");

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
      setInstructions(prefill.instructions);
    } else {
      setAgent(agents[0]?.agent.fqn ?? "");
      setRuntime(runtimes[0] ?? "");
      setInstructions("");
    }
  }, [open, agents, runtimes, prefill]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent || !instructions.trim()) return;
    onDispatch(agent, instructions.trim(), runtime || undefined);
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
      //   - activity timeline (small parsed JSON; drives Activity tab,
      //     Result panel, AND the Raw tab — which now just renders the
      //     activity payload as JSON, no separate request needed)
      await Promise.all([
        getTask(taskId).then((t) => {
          if (!mountedRef.current || token !== taskTokenRef.current) return;
          setTask(t);
        }),
        fetchTaskActivity(taskId)
          .then((a) => {
            if (!mountedRef.current || token !== taskTokenRef.current) return;
            setActivity(a);
            setActivityError(null);
          })
          .catch((e) => {
            if (!mountedRef.current || token !== taskTokenRef.current) return;
            setActivity(null);
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
    // header until the new fetch resolves.
    setTask(null);
    setActivity(null);
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
  const isRunning = task && (task.status === "running" || task.status === "not_started");

  return (
    <aside className="tasks-pane__detail">
      <header className="task-detail__head">
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
              title="Re-dispatch with the same agent + instructions"
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
        {task?.instructions && (
          <p className="task-detail__instructions" title={task.instructions}>
            {task.instructions}
          </p>
        )}
        {task?.failure && (
          <div className="alert alert--error" style={{ margin: 0 }}>
            <strong>Failure:</strong> {task.failure.error}
            {exitCode !== undefined && exitCode !== null && <> (exit {exitCode})</>}
            {exitSignal && <> [signal {exitSignal}]</>}
          </div>
        )}
      </header>

      {/* Result block — the agent's final answer, the headline thing
          a user wants to see. Falls back gracefully:
            1. derived `activity.result` (last assistant message) if any
            2. raw task.result.output if the kernel captured one
            3. nothing (don't render a noisy empty box) */}
      {(() => {
        const headlineResult =
          activity?.result ??
          (typeof task?.result?.output === "string" && task.result.output.length > 0
            ? task.result.output
            : null);
        if (!headlineResult) return null;
        return (
          <section className="task-detail__result">
            <h3 className="task-detail__section-title">Result</h3>
            <p className="task-detail__result-body">{headlineResult}</p>
          </section>
        );
      })()}

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
        <div className="task-detail__body">
          <ActivityView activity={activity} activityError={activityError} />
        </div>
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
}: {
  activity: TaskActivity | null;
  activityError: string | null;
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
  return (
    <ol className="activity-list">
      {activity.activity.map((item) => (
        // Timestamps are runtime-emitted UUIDs-in-time and are unique
        // per event; the activity list is append-only (never reordered),
        // so timestamp-as-key is stable across re-renders.
        <ActivityRow key={item.timestamp} item={item} />
      ))}
    </ol>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  if (item.kind === "summary") {
    const s = item.summary;
    const codeChanged = s.linesAdded > 0 || s.linesRemoved > 0 || s.filesModified.length > 0;
    return (
      <li className="activity-row activity-row--summary">
        <div className="activity-row__head">
          <span className="activity-row__role activity-row__role--summary">Summary</span>
          <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
            {formatRelative(item.timestamp)}
          </time>
        </div>
        <div className="activity-row__summary-grid">
          {codeChanged ? (
            <span>
              <strong>Code:</strong> +{s.linesAdded} −{s.linesRemoved} across{" "}
              {s.filesModified.length} file{s.filesModified.length === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="muted">No code changes</span>
          )}
          {s.premiumRequests > 0 && (
            <span>
              <strong>Premium requests:</strong> {s.premiumRequests}
            </span>
          )}
          {(s.inputTokens > 0 || s.outputTokens > 0) && (
            <span>
              <strong>Tokens:</strong> {s.inputTokens.toLocaleString()} in /{" "}
              {s.outputTokens.toLocaleString()} out
            </span>
          )}
          {s.model && (
            <span>
              <strong>Model:</strong> {s.model}
            </span>
          )}
        </div>
      </li>
    );
  }
  return (
    <li className={`activity-row activity-row--${item.kind}`}>
      <div className="activity-row__head">
        <span className={`activity-row__role activity-row__role--${item.kind}`}>
          {item.kind === "user" ? "User" : "Assistant"}
        </span>
        <time className="activity-row__time" title={formatAbsolute(item.timestamp)}>
          {formatRelative(item.timestamp)}
        </time>
      </div>
      {item.content.length > 0 && <p className="activity-row__body">{item.content}</p>}
      {item.kind === "assistant" && item.toolRequests.length > 0 && (
        <div className="activity-row__tools">
          {item.toolRequests.map((t) => {
            // Tool calls within a single assistant message are emitted as
            // a list; same tool name can repeat, so we hash the args into
            // the key to keep React happy when the message re-renders
            // (e.g. during a poll tick that returns the same content).
            const key = `${t.name}::${JSON.stringify(t.arguments ?? {})}`;
            return (
              <span key={key} className="activity-row__tool" title={t.name}>
                {t.name}
              </span>
            );
          })}
        </div>
      )}
    </li>
  );
}

// ─ helpers ─

import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  deleteTask,
  dispatchTask,
  fetchTaskEvents,
  getTask,
  listTasks,
  type TaskRecord,
  type TaskStatus,
} from "../api";
import { PlusIcon, RefreshIcon, TrashIcon } from "../components/Icons";
import { Modal } from "../components/Modal";

interface TasksProps {
  agents: AgentEntry[];
  /** UUID of the workspace currently in scope (from the URL); null = no workspace. */
  currentWorkspaceId: string | null;
}

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

/**
 * Tasks page — fire-and-forget agent dispatch, autonomous run, polling
 * detail view. Lives parallel to Sessions: sessions are interactive
 * workdirs you `copilot` into, tasks are non-interactive runs you read
 * the events.jsonl from afterwards.
 *
 * The detail view is implemented as a side panel on the same page rather
 * than a new route so we don't have to thread URL parameters through the
 * App.tsx router for the MVP. If we add task deep-linking later it's a
 * mechanical refactor.
 */
export function TasksPage({ agents, currentWorkspaceId }: TasksProps) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskRecord | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!currentWorkspaceId) {
      setTasks([]);
      setLoaded(true);
      return;
    }
    setRefreshing(true);
    try {
      const next = await listTasks();
      if (!mountedRef.current) return;
      setError(null);
      // Newest-first by createdAt — id is also timestamp-prefixed but
      // sorting on createdAt is the contract we want to depend on.
      next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setTasks(next);
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) {
        setRefreshing(false);
        setLoaded(true);
      }
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh while any task is running so the dashboard catches the
  // success/failure transition without the user pressing Refresh. 4s is
  // a tradeoff between snappiness and load — the manager polls task.json
  // through the file system, so requests are cheap.
  useEffect(() => {
    const anyRunning = tasks.some((t) => t.status === "running" || t.status === "not_started");
    if (!anyRunning || !currentWorkspaceId) return;
    const handle = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(handle);
  }, [tasks, currentWorkspaceId, refresh]);

  const onDispatched = async (agent: string, instructions: string) => {
    setBusy(true);
    setError(null);
    try {
      const created = await dispatchTask(agent, instructions);
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
        <div className="page-toolbar__actions" style={{ alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {tasks.length} task{tasks.length === 1 ? "" : "s"}
          </span>
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
      ) : tasks.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">📝</div>
          <p className="empty__title">No tasks yet</p>
          <p className="empty__hint">
            Dispatch a task to run an agent autonomously and read the result here when it finishes.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 480px", gap: 16 }}>
          <table className="table table--wide">
            <thead>
              <tr>
                <th>Task</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Started</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  selected={selectedId === t.id}
                  onSelect={() => setSelectedId(t.id)}
                  onDelete={() => setDeleteTarget(t)}
                />
              ))}
            </tbody>
          </table>

          <TaskDetailPanel
            taskId={selectedId}
            onClose={() => setSelectedId(null)}
            onDeleted={async () => {
              setSelectedId(null);
              await refresh();
            }}
          />
        </div>
      )}

      <DispatchModal
        open={dispatchOpen}
        agents={readyAgents}
        busy={busy}
        onClose={() => setDispatchOpen(false)}
        onDispatch={onDispatched}
      />

      {deleteTarget && (
        <Modal open={true} onClose={() => setDeleteTarget(null)} title="Delete task" size="default">
          <p>
            Delete task <code>{shortId(deleteTarget.id)}</code>? This kills the subprocess if it's
            still running and removes the workdir.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
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

interface TaskRowProps {
  task: TaskRecord;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function TaskRow({ task, selected, onSelect, onDelete }: TaskRowProps) {
  const tone = STATUS_TONE[task.status];
  return (
    <tr
      onClick={onSelect}
      style={{
        cursor: "pointer",
        background: selected ? "var(--surface-2, rgba(255,255,255,0.04))" : undefined,
      }}
    >
      <td>
        <code title={task.id}>{shortId(task.id)}</code>
      </td>
      <td>{task.agent}</td>
      <td>
        <span className={`badge badge--${tone}`}>{STATUS_LABEL[task.status]}</span>
      </td>
      <td className="muted" style={{ fontSize: 12 }}>
        {task.startedAt ? formatTime(task.startedAt) : "—"}
      </td>
      <td className="col-actions">
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
      </td>
    </tr>
  );
}

interface DispatchModalProps {
  open: boolean;
  agents: AgentEntry[];
  busy: boolean;
  onClose: () => void;
  onDispatch: (agent: string, instructions: string) => void;
}

function DispatchModal({ open, agents, busy, onClose, onDispatch }: DispatchModalProps) {
  const [agent, setAgent] = useState<string>("");
  const [instructions, setInstructions] = useState("");

  // Reset form on open so re-opening doesn't replay the previous dispatch.
  useEffect(() => {
    if (open) {
      setAgent(agents[0]?.agent.name ?? "");
      setInstructions("");
    }
  }, [open, agents]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent || !instructions.trim()) return;
    onDispatch(agent, instructions.trim());
  };

  return (
    <Modal open={open} onClose={onClose} title="Dispatch task" size="default">
      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label htmlFor="task-agent" className="muted" style={{ fontSize: 12 }}>
          Agent
        </label>
        <select
          id="task-agent"
          className="select"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          required
        >
          {agents.map((a) => (
            <option key={a.agent.name} value={a.agent.name}>
              {a.agent.name}
            </option>
          ))}
        </select>

        <label htmlFor="task-instructions" className="muted" style={{ fontSize: 12 }}>
          Instructions
        </label>
        <textarea
          id="task-instructions"
          className="input"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What should the agent do?"
          rows={8}
          required
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
  onDeleted: () => void;
}

type DetailTab = "events" | "metadata";

function TaskDetailPanel({ taskId, onClose }: TaskDetailPanelProps) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [events, setEvents] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("events");
  const [loading, setLoading] = useState(false);

  const refreshDetail = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const t = await getTask(taskId);
      setTask(t);
      try {
        const ev = await fetchTaskEvents(taskId);
        setEvents(ev);
        setEventsError(null);
      } catch (e) {
        setEventsError((e as Error).message);
        setEvents(null);
      }
    } catch (e) {
      setTask(null);
      setEventsError((e as Error).message);
    } finally {
      setLoading(false);
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

  // Auto-poll while running so events.jsonl + status update without
  // a manual refresh click.
  useEffect(() => {
    if (!task || (task.status !== "running" && task.status !== "not_started")) return;
    const handle = setInterval(() => {
      void refreshDetail();
    }, 4000);
    return () => clearInterval(handle);
  }, [task, refreshDetail]);

  if (!taskId) {
    return (
      <aside
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 16,
          minHeight: 240,
        }}
      >
        <p className="muted">Select a task to view details.</p>
      </aside>
    );
  }

  return (
    <aside
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        maxHeight: "calc(100vh - 220px)",
        overflow: "hidden",
      }}
    >
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
        <div className="muted" style={{ fontSize: 12 }}>
          <div>
            <strong>Agent:</strong> {task.agent}
          </div>
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
            <div style={{ marginTop: 8, color: "var(--warn, #d97706)" }}>
              <strong>Failure:</strong> {task.failure.reason}
              {task.failure.exitCode !== undefined && task.failure.exitCode !== null && (
                <> (exit {task.failure.exitCode})</>
              )}
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
 * Pretty-print an events.jsonl payload by parsing each line and showing the
 * timestamp + type prefix on its own line. Lines that don't parse as JSON
 * are passed through verbatim so we don't lose any information.
 */
function formatEventsJsonl(raw: string): string {
  const lines = raw.split(/\r?\n/);
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

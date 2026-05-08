import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type CopilotSessionInfo,
  createSession,
  deleteSession,
  getLaunchCommand,
  getResumeCommand,
  type LaunchCommand,
  listSessions,
  type SessionRecord,
} from "../api";
import { CopyIcon, PlayIcon, PlusIcon, RefreshIcon, TrashIcon } from "../components/Icons";
import { Modal } from "../components/Modal";

interface SessionsProps {
  agents: AgentEntry[];
}

interface LaunchModalState {
  session: SessionRecord;
  command: LaunchCommand;
}

interface DeleteModalState {
  session: SessionRecord;
  alsoDeleteCopilotState: boolean;
}

const ALL_AGENTS = "__all__";

/**
 * Sessions page — manages emploke session workdirs and shows the matching
 * Copilot sessions discovered for each. The page does NOT spawn copilot;
 * it returns a launch command for the user to copy and run themselves.
 */
export function SessionsPage({ agents }: SessionsProps) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [filter, setFilter] = useState<string>(ALL_AGENTS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [launchModal, setLaunchModal] = useState<LaunchModalState | null>(null);
  const [deleteModal, setDeleteModal] = useState<DeleteModalState | null>(null);

  // Tracks whether the component is still mounted so async handlers can skip
  // setState calls on a tombstoned instance. CRITICAL: the effect must reset
  // mountedRef to true on EVERY mount, not just the first — otherwise React 18
  // StrictMode (which runs mount→unmount→mount in dev) leaves it stuck at
  // false after the first cleanup, silently swallowing all post-await state
  // updates (e.g. setBusy(false) never fires and the button stays "Creating…").
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await listSessions(filter === ALL_AGENTS ? undefined : filter);
      if (!mountedRef.current) return;
      setError(null);
      setSessions(next);
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh defined inline; runs on filter change
  useEffect(() => {
    refresh();
  }, [filter]);

  const onCreated = async (agent: string) => {
    setBusy(true);
    setError(null);
    try {
      await createSession(agent);
      if (!mountedRef.current) return;
      setCreateOpen(false);
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const onLaunch = async (s: SessionRecord) => {
    setError(null);
    try {
      const cmd = await getLaunchCommand(s.id);
      if (!mountedRef.current) return;
      setLaunchModal({ session: s, command: cmd });
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    }
  };

  const onConfirmDelete = async () => {
    if (!deleteModal) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSession(deleteModal.session.id, deleteModal.alsoDeleteCopilotState);
      if (!mountedRef.current) return;
      setDeleteModal(null);
      await refresh();
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const readyAgents = agents.filter((a) => a.status === "ready");

  return (
    <>
      <div className="page-toolbar">
        <div
          className="page-toolbar__actions"
          style={{ gap: "var(--space-3)", alignItems: "center" }}
        >
          <label htmlFor="agent-filter" className="muted" style={{ fontSize: 12 }}>
            Agent
          </label>
          <select
            id="agent-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="select"
          >
            <option value={ALL_AGENTS}>All</option>
            {agents.map((a) => (
              <option key={a.agent.name} value={a.agent.name}>
                {a.agent.name}
              </option>
            ))}
          </select>
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
            onClick={() => setCreateOpen(true)}
            disabled={readyAgents.length === 0}
            title={
              readyAgents.length === 0
                ? "Install at least one ready agent in the Catalog first"
                : "Create a new session"
            }
          >
            <PlusIcon />
            <span>New session</span>
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">⚠️ {error}</div>}

      {sessions.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">📂</div>
          <p className="empty__title">No sessions yet</p>
          <p className="empty__hint">
            Create a session to bake an agent into a workdir, then launch <code>copilot -i</code>{" "}
            there.
          </p>
        </div>
      ) : (
        <table className="table table--wide">
          <thead>
            <tr>
              <th className="col-session">Session</th>
              <th className="col-agent">Agent</th>
              <th>Activity</th>
              <th className="col-created">Created</th>
              <th className="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onLaunch={() => onLaunch(s)}
                onDelete={() => setDeleteModal({ session: s, alsoDeleteCopilotState: false })}
              />
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={createOpen}
        agents={readyAgents}
        busy={busy}
        onClose={() => setCreateOpen(false)}
        onCreate={onCreated}
      />

      {launchModal && (
        <Modal
          open={true}
          onClose={() => setLaunchModal(null)}
          title="Launch session"
          size="default"
        >
          <LaunchModalBody
            session={launchModal.session}
            command={launchModal.command}
            onClose={() => setLaunchModal(null)}
          />
        </Modal>
      )}

      {deleteModal && (
        <Modal
          open={true}
          onClose={() => setDeleteModal(null)}
          title="Delete session"
          size="default"
        >
          <DeleteModalBody
            session={deleteModal.session}
            alsoDeleteCopilotState={deleteModal.alsoDeleteCopilotState}
            busy={busy}
            onToggle={(v) =>
              setDeleteModal((prev) => (prev ? { ...prev, alsoDeleteCopilotState: v } : prev))
            }
            onCancel={() => setDeleteModal(null)}
            onConfirm={onConfirmDelete}
          />
        </Modal>
      )}
    </>
  );
}

// ─── Row ─────────────────────────────────────────────────────

interface RowProps {
  session: SessionRecord;
  onLaunch: () => void;
  onDelete: () => void;
}

function SessionRow({ session, onLaunch, onDelete }: RowProps) {
  return (
    <tr>
      <td className="col-session" title={session.workdir}>
        <span className="session-id">{session.id}</span>
      </td>
      <td className="col-agent">
        <span className="agent-tag" title={session.agent}>
          {session.agent}
        </span>
      </td>
      <td>
        <ActivityCell session={session} />
      </td>
      <td className="muted">{formatRelative(session.createdAt)}</td>
      <td>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            title={
              session.copilotSessions.length > 0 ? "Launch (resume option in dialog)" : "Launch"
            }
            onClick={onLaunch}
          >
            <PlayIcon />
          </button>
          <CopyPathButton path={session.workdir} />
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            title="Delete session"
            onClick={onDelete}
          >
            <TrashIcon />
          </button>
        </div>
      </td>
    </tr>
  );
}

function ActivityCell({ session }: { session: SessionRecord }) {
  const count = session.copilotSessions.length;
  if (count === 0) {
    return <span className="muted">—</span>;
  }
  const latest = session.latestCopilotSession;
  return (
    <span className="activity-cell" title={latest?.summary ?? undefined}>
      <span className="activity-cell__count">{count}</span>
      <span className="activity-cell__label muted">{count === 1 ? "chat" : "chats"}</span>
      {latest?.updatedAt && (
        <>
          <span className="activity-cell__sep">·</span>
          <span className="muted">{formatRelative(latest.updatedAt)}</span>
        </>
      )}
    </span>
  );
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch {
      // Clipboard may be unavailable in non-secure contexts.
    }
  };
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      title={copied ? "Copied!" : `Copy workdir path (${path})`}
      aria-label="Copy workdir path"
      onClick={onCopy}
    >
      <CopyIcon />
    </button>
  );
}

// ─── Create modal ─────────────────────────────────────────────

interface CreateModalProps {
  open: boolean;
  agents: AgentEntry[];
  busy: boolean;
  onClose: () => void;
  onCreate: (agent: string) => void;
}

function CreateModal({ open, agents, busy, onClose, onCreate }: CreateModalProps) {
  const [agent, setAgent] = useState<string>("");

  useEffect(() => {
    if (open && agents.length > 0 && !agents.some((a) => a.agent.name === agent)) {
      setAgent(agents[0]?.agent.name ?? "");
    }
  }, [open, agents, agent]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent) return;
    onCreate(agent);
  };

  return (
    <Modal open={open} onClose={onClose} title="New session" size="default">
      <form onSubmit={onSubmit} style={{ display: "grid", gap: "var(--space-3)" }}>
        <label htmlFor="new-session-agent">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Agent
          </div>
          <select
            id="new-session-agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            disabled={busy}
            required
            className="select select--full"
          >
            {agents.map((a) => (
              <option key={a.agent.name} value={a.agent.name}>
                {a.agent.name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          A new workdir will be created at <code>~/.emploke/sessions/&lt;id&gt;</code> and the agent
          will be baked into it.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !agent}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Launch modal ─────────────────────────────────────────────

interface LaunchModalBodyProps {
  session: SessionRecord;
  command: LaunchCommand;
  onClose: () => void;
}

function LaunchModalBody({ session, command, onClose }: LaunchModalBodyProps) {
  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      <div>
        <div className="muted" style={{ fontSize: 12 }}>
          Session
        </div>
        <div className="mono" style={{ fontSize: 13 }}>
          {session.id}
        </div>
      </div>
      <div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Run this in your terminal to start a fresh chat
        </div>
        <CopyRow text={command.display} />
      </div>
      {session.copilotSessions.length > 0 && <ResumePicker session={session} />}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

interface ResumePickerProps {
  session: SessionRecord;
}

function ResumePicker({ session }: ResumePickerProps) {
  const [picked, setPicked] = useState<CopilotSessionInfo | null>(null);
  const [cmd, setCmd] = useState<LaunchCommand | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onPick = async (info: CopilotSessionInfo) => {
    setError(null);
    try {
      const c = await getResumeCommand(session.id, info.sessionId);
      if (!mountedRef.current) return;
      setPicked(info);
      setCmd(c);
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Resume a previous copilot session ({session.copilotSessions.length})
      </div>
      <select
        onChange={(e) => {
          const info = session.copilotSessions.find((s) => s.sessionId === e.target.value);
          if (info) onPick(info);
        }}
        value={picked?.sessionId ?? ""}
        className="select select--full"
        style={{ marginBottom: 8 }}
      >
        <option value="" disabled>
          Choose…
        </option>
        {session.copilotSessions.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {s.name ?? s.sessionId} {s.updatedAt ? `· ${formatRelative(s.updatedAt)}` : ""}
          </option>
        ))}
      </select>
      {error && <div className="alert alert--error">⚠️ {error}</div>}
      {cmd && <CopyRow text={cmd.display} />}
    </div>
  );
}

// ─── Delete modal ─────────────────────────────────────────────

interface DeleteModalBodyProps {
  session: SessionRecord;
  alsoDeleteCopilotState: boolean;
  busy: boolean;
  onToggle: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteModalBody({
  session,
  alsoDeleteCopilotState,
  busy,
  onToggle,
  onCancel,
  onConfirm,
}: DeleteModalBodyProps) {
  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      <p>
        Delete session <code>{session.id}</code> ({session.agent})?
      </p>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        This removes the workdir at <code>{session.workdir}</code>.
      </p>
      {session.copilotSessions.length > 0 && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={alsoDeleteCopilotState}
            onChange={(e) => onToggle(e.target.checked)}
            disabled={busy}
          />
          Also delete {session.copilotSessions.length} copilot session
          {session.copilotSessions.length === 1 ? "" : "s"} from
          <code>~/.copilot/session-state/</code>
        </label>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────

interface CopyRowProps {
  text: string;
}

function CopyRow({ text }: CopyRowProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch {
      // Clipboard may be unavailable in non-secure contexts; user can select
      // the text manually.
    }
  };
  return (
    <div className="copy-row">
      <span className="copy-row__text">{text}</span>
      <button
        type="button"
        className="btn btn--ghost btn--icon copy-row__btn"
        onClick={onCopy}
        title={copied ? "Copied!" : "Copy to clipboard"}
        aria-label="Copy to clipboard"
      >
        <CopyIcon />
      </button>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

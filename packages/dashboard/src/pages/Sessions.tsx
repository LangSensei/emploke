import type { AgentEntry } from "@emploke/catalog";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  createSession,
  deleteSession,
  listRuntimes,
  listSessions,
  type ServerConfig,
  type SessionRecord,
  spawnSession,
  type WorkspaceListItem,
} from "../api";
import {
  ChevronDownIcon,
  CopyIcon,
  GlobeIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from "../components/Icons";
import { Modal } from "../components/Modal";
import { serverNow } from "../serverClock";
import { formatRelative } from "../utils/time";

interface SessionsProps {
  agents: AgentEntry[];
  config: ServerConfig | null;
  /** UUID of the workspace currently in scope (from the URL); null = no workspace. */
  currentWorkspaceId: string | null;
  /** Full registered-workspace list, used to resolve display name for the workdir hint. */
  workspaces: WorkspaceListItem[];
}

interface FallbackInfo {
  display: string;
  reason: string;
}

interface DeleteModalState {
  session: SessionRecord;
  /**
   * `true` = purge mode: also wipe the workdir and the runtime adapter's
   * per-session state. `false` = archive (default): only the metadata
   * row is removed; workdir + runtime state are preserved on disk.
   */
  purge: boolean;
}

const ALL_AGENTS = "__all__";
const ALL_RUNTIMES = "__all__";

const TIME_PRESETS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
] as const;
type TimePreset = (typeof TIME_PRESETS)[number]["value"];

const DEFAULT_TIME_PRESET: TimePreset = "7d";

/**
 * Convert a preset to an ISO 8601 lower bound for the **lastActiveAt**
 * filter (was `createdAt` until #43; "most recent activity" matches the
 * UX of every chat / messaging app and is what users actually mean when
 * they pick "Today" or "7d" in the time picker).
 *
 * Anchored on `now` (defaults to `serverNow()` from `../serverClock`)
 * so cutoffs are computed against the **server's** clock, not the
 * user's laptop. Without this, a clock-skewed laptop can hide today's
 * sessions behind a future-dated "today" cutoff or include yesterday's
 * with a stale one.
 *
 * Sessions that have never been launched (`lastActiveAt === null`) are
 * excluded by any non-`all` preset — by definition they have no
 * activity to be recent.
 */
function presetToActiveSince(preset: TimePreset, now: Date = serverNow()): string | undefined {
  switch (preset) {
    case "today": {
      // Local-time midnight. The server compares ISO strings, so we send the
      // resulting UTC moment as Z-suffixed ISO.
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }
    case "7d":
      return new Date(now.getTime() - 7 * 86_400_000).toISOString();
    case "30d":
      return new Date(now.getTime() - 30 * 86_400_000).toISOString();
    case "all":
      return undefined;
  }
}

/**
 * Sessions page — lists per-session workdirs managed by the runtime registry
 * and lets the user create, launch, and delete them. The Launch button asks
 * the server to spawn the user's terminal directly. If spawning fails (e.g.
 * no terminal emulator could be detected), we fall back to showing the
 * incantation in a modal so the user can still copy-paste it.
 */
export function SessionsPage({ agents, config, currentWorkspaceId, workspaces }: SessionsProps) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>(ALL_AGENTS);
  const [runtimeFilter, setRuntimeFilter] = useState<string>(ALL_RUNTIMES);
  const [timeFilter, setTimeFilter] = useState<TimePreset>(DEFAULT_TIME_PRESET);
  const [idQuery, setIdQuery] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Distinguishes "haven't loaded yet" from "loaded with zero results" so the
  // initial mount shows a spinner instead of the misleading "No sessions yet"
  // empty state for however long the first GET takes.
  const [loaded, setLoaded] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [fallback, setFallback] = useState<FallbackInfo | null>(null);
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
    if (!currentWorkspaceId) {
      setSessions([]);
      setLoaded(true);
      return;
    }
    setRefreshing(true);
    try {
      const next = await listSessions({
        agent: filter === ALL_AGENTS ? undefined : filter,
        activeSince: presetToActiveSince(timeFilter),
      });
      if (!mountedRef.current) return;
      setError(null);
      setSessions(next);
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) {
        setRefreshing(false);
        setLoaded(true);
      }
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh defined inline; runs on filter/timeFilter/workspace change
  useEffect(() => {
    refresh();
  }, [filter, timeFilter, currentWorkspaceId]);

  // Fetch the registered runtimes once at mount; the registry is static
  // for a given server process so we don't need to re-poll.
  useEffect(() => {
    let cancelled = false;
    listRuntimes()
      .then((rts) => {
        if (!cancelled) setRuntimes(rts.map((r) => r.kind));
      })
      .catch(() => {
        // Non-fatal: CreateModal falls back to omitting the runtime field,
        // which makes the server pick its default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onCreated = async (agent: string, runtime: string | undefined) => {
    setBusy(true);
    setError(null);
    try {
      await createSession(agent, runtime);
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

  const onLaunch = async (s: SessionRecord, opts: { remote?: boolean } = {}) => {
    if (launchingId !== null) return;
    setLaunchingId(s.id);
    setError(null);
    try {
      // Resume vs fresh is decided by the runtime now: if a runtimeSessionId
      // is persisted, buildLaunch will produce a `--resume=<id>` form; if not,
      // it produces a bare launch. Either way the dashboard just asks to spawn.
      // `opts.remote` selects between the two spawn buttons in the row;
      // server validates against the runtime's capabilities and 400s if
      // unsupported (defensive — disabled buttons in the UI are the
      // first line of defence).
      const result = await spawnSession(s.id, opts);
      if (!mountedRef.current) return;
      if (!result.ok) {
        // Server returned 200 but couldn't spawn a terminal — show the
        // command so the user can paste it into their own shell.
        setFallback({ display: result.display, reason: result.error });
      }
      // Refresh after a successful launch so lastActiveAt/preview update.
      if (result.ok) {
        if (!mountedRef.current) return;
        await refresh();
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError((e as Error).message);
    } finally {
      if (mountedRef.current) setLaunchingId(null);
    }
  };

  const onConfirmDelete = async () => {
    if (!deleteModal) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSession(deleteModal.session.id, { purge: deleteModal.purge });
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

  // Client-side filters layered on top of the server-side agent narrow.
  // Both are interactive (typing / dropdown change), so doing them in-memory
  // avoids a round-trip per keystroke and keeps the UI snappy.
  const visibleSessions = (() => {
    const q = idQuery.trim().toLowerCase();
    return sessions.filter((s) => {
      if (q !== "" && !s.id.toLowerCase().includes(q)) return false;
      if (runtimeFilter !== ALL_RUNTIMES && s.runtime !== runtimeFilter) return false;
      return true;
    });
  })();

  if (currentWorkspaceId === null) {
    return (
      <div className="alert alert--error">
        No workspace is selected. Use the workspace dropdown in the top bar to choose or create one
        — sessions are scoped to a workspace.
      </div>
    );
  }

  // The workdir hint shows the user-facing display name (not the UUID),
  // falling back to the id only if metadata hasn't loaded yet.
  const currentDisplayName =
    workspaces.find((w) => w.id === currentWorkspaceId)?.name ?? currentWorkspaceId;

  return (
    <>
      <div className="page-toolbar">
        <div
          className="page-toolbar__actions"
          style={{ gap: "var(--space-3)", alignItems: "center" }}
        >
          <label htmlFor="session-id-filter" className="muted" style={{ fontSize: 12 }}>
            Search
          </label>
          <input
            id="session-id-filter"
            type="search"
            value={idQuery}
            onChange={(e) => setIdQuery(e.target.value)}
            placeholder="session id…"
            className="input"
            // Session ids are fixed-width (`YYYYMMDD-xxxxxxxx`, 17 chars).
            // 160px is the sweet spot — holds the full id, the search-input
            // clear-x, and a bit of breathing room. The original 200px was
            // wasted; 150 was a hair too tight.
            style={{ width: 160 }}
          />
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
              <option key={a.agent.fqn} value={a.agent.fqn}>
                {a.agent.fqn}
              </option>
            ))}
          </select>
          <label htmlFor="runtime-filter" className="muted" style={{ fontSize: 12 }}>
            Runtime
          </label>
          <select
            id="runtime-filter"
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
            Active
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

      {!loaded ? (
        <div className="empty">
          <div className="empty__icon spin" aria-hidden="true">
            <RefreshIcon />
          </div>
          <p className="empty__title">Loading sessions…</p>
        </div>
      ) : visibleSessions.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">📂</div>
          <p className="empty__title">{sessions.length === 0 ? "No sessions yet" : "No matches"}</p>
          <p className="empty__hint">
            {sessions.length === 0 ? (
              <>
                Create a session to bake an agent into a workdir, then launch <code>copilot</code>{" "}
                there.
              </>
            ) : (
              <>Adjust the filters above to see more sessions.</>
            )}
          </p>
        </div>
      ) : (
        <ul className="session-list" aria-label="Sessions">
          {visibleSessions.map((s) => (
            <SessionListItem
              key={s.id}
              session={s}
              launching={launchingId === s.id}
              onLaunch={(opts) => onLaunch(s, opts)}
              onDelete={() => setDeleteModal({ session: s, purge: false })}
            />
          ))}
        </ul>
      )}

      <CreateModal
        open={createOpen}
        agents={readyAgents}
        runtimes={runtimes}
        workspaceDisplayName={currentDisplayName}
        pathSeparator={config?.pathSeparator ?? "/"}
        busy={busy}
        onClose={() => setCreateOpen(false)}
        onCreate={onCreated}
      />

      {fallback && (
        <Modal
          open={true}
          onClose={() => setFallback(null)}
          title="Couldn't open a terminal"
          size="default"
        >
          <FallbackModalBody
            display={fallback.display}
            reason={fallback.reason}
            onClose={() => setFallback(null)}
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
            purge={deleteModal.purge}
            busy={busy}
            onToggle={(v) => setDeleteModal((prev) => (prev ? { ...prev, purge: v } : prev))}
            onCancel={() => setDeleteModal(null)}
            onConfirm={onConfirmDelete}
          />
        </Modal>
      )}
    </>
  );
}

// ─── List item ───────────────────────────────────────────────

interface ListItemProps {
  session: SessionRecord;
  launching: boolean;
  onLaunch: (opts: { remote?: boolean }) => void;
  onDelete: () => void;
}

/**
 * One row of the sessions list. Two-row layout:
 *
 *   row 1: id · agent chip · runtime chip · — spacer — · action buttons
 *   row 2: activity preview · separator · "20m ago" (muted)
 *
 * Mirrors the Tasks list's `.task-list__item` shape so the two
 * primary "running entity" pages read consistently. Replaces the
 * earlier `<table>` whose fixed columns left the actions cell
 * widthless and made chip widths jitter across rows.
 */
function SessionListItem({ session, launching, onLaunch, onDelete }: ListItemProps) {
  const hasHistory = session.runtimeSessionId !== null && session.lastActiveAt !== null;
  const verb = hasHistory ? "Resume" : "Launch";
  // Default the primary action to whatever the user picked last for
  // this session, so a "remote-mostly" session keeps offering remote
  // as one click. Falls back to local on first launch (the safe and
  // historically conventional choice).
  const defaultMode: "local" | "remote" = session.lastLaunchMode ?? "local";
  return (
    <li className="session-list__item">
      <div className="session-list__head">
        <div className="session-list__headline" title={`Agent: ${session.agent}`}>
          {session.agent}
        </div>
        <div className="session-list__actions">
          <ResumeSplitButton
            verb={verb}
            launching={launching}
            defaultMode={defaultMode}
            onLaunch={onLaunch}
          />
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
      </div>
      <div className="session-list__activity">
        <SessionActivity session={session} />
      </div>
      {/* Combined footer: runtime + id on one muted line, matching the
          Tasks-list pattern. Avoids the previous dedicated-row-per-
          field layout that wasted vertical space and gave secondary
          metadata (runtime) the same visual weight as primary
          metadata (the activity preview). */}
      <div className="session-list__meta muted">
        <span title={`Runtime: ${session.runtime}`}>{session.runtime}</span>
        <span className="session-list__sep">·</span>
        <code className="session-list__id" title={session.workdir}>
          {session.id}
        </code>
      </div>
    </li>
  );
}

/**
 * GitHub-style "Code"-button split control: clicking the main face
 * launches in `defaultMode`; clicking the chevron opens a small menu
 * with both modes. The selected option becomes the next default
 * (persisted server-side as `session.lastLaunchMode`), so this
 * component only controls *immediate intent* — persistence is the
 * server's job.
 *
 * Why split-button (not two buttons): the visual layout of two equal
 * buttons gave both modes equal weight, but the dominant case is "I
 * just want to resume the same way I did last time". The split makes
 * primary one click while keeping the alternate mode visible (the
 * chevron is the affordance).
 */
function ResumeSplitButton({
  verb,
  launching,
  defaultMode,
  onLaunch,
}: {
  verb: string;
  launching: boolean;
  defaultMode: "local" | "remote";
  onLaunch: (opts: { remote?: boolean }) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape — small ad-hoc dropdown without a
  // full popover library.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const fire = (mode: "local" | "remote") => {
    setMenuOpen(false);
    onLaunch(mode === "remote" ? { remote: true } : {});
  };

  const mainTitle = launching
    ? "Opening terminal…"
    : defaultMode === "remote"
      ? `${verb} in terminal with remote control (web & mobile)`
      : `${verb} in a new terminal`;

  return (
    <div className="resume-split" ref={wrapRef}>
      <button
        type="button"
        className="btn btn--primary resume-split__main"
        title={mainTitle}
        disabled={launching}
        onClick={() => fire(defaultMode)}
      >
        {launching ? (
          <RefreshIcon className="spin" />
        ) : defaultMode === "remote" ? (
          <GlobeIcon />
        ) : (
          <PlayIcon />
        )}
        <span>{defaultMode === "remote" ? `${verb} remote` : verb}</span>
      </button>
      <button
        type="button"
        className="btn btn--primary resume-split__chevron"
        title="Choose where to resume"
        aria-label="Resume options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={launching}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <ChevronDownIcon />
      </button>
      {menuOpen && (
        <div className="resume-split__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className={`resume-split__menu-item${
              defaultMode === "local" ? " resume-split__menu-item--active" : ""
            }`}
            onClick={() => fire("local")}
          >
            <PlayIcon />
            <div className="resume-split__menu-text">
              <span className="resume-split__menu-title">{verb} local only</span>
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            className={`resume-split__menu-item${
              defaultMode === "remote" ? " resume-split__menu-item--active" : ""
            }`}
            onClick={() => fire("remote")}
          >
            <GlobeIcon />
            <div className="resume-split__menu-text">
              <span className="resume-split__menu-title">{verb} with remote control</span>
              <span className="resume-split__menu-hint">Web &amp; mobile</span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

function SessionActivity({ session }: { session: SessionRecord }) {
  if (session.lastActiveAt === null) {
    return <span className="muted">never run</span>;
  }
  return (
    <span className="activity-cell" title={session.preview ?? undefined}>
      {session.preview && (
        <>
          {/* No JS-side length cap: CSS (overflow: hidden + text-overflow:
              ellipsis on .activity-cell__count) handles truncation based on
              the actual row width, so wide screens show more text instead
              of always cutting at 32 chars. The hover title still shows the
              full preview. */}
          <span className="activity-cell__count">{session.preview}</span>
          <span className="activity-cell__sep">·</span>
        </>
      )}
      <span className="muted">{formatRelative(session.lastActiveAt)}</span>
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
  runtimes: string[];
  /** Display name of the active workspace, used in the "where will it land" hint. */
  workspaceDisplayName: string | null;
  /** Native path separator on the server's OS (e.g. `\\` on Windows). */
  pathSeparator: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (agent: string, runtime: string | undefined) => void;
}

function CreateModal({
  open,
  agents,
  runtimes,
  workspaceDisplayName,
  pathSeparator,
  busy,
  onClose,
  onCreate,
}: CreateModalProps) {
  const [agent, setAgent] = useState<string>("");
  const [runtime, setRuntime] = useState<string>("");

  useEffect(() => {
    if (open && agents.length > 0 && !agents.some((a) => a.agent.fqn === agent)) {
      setAgent(agents[0]?.agent.fqn ?? "");
    }
  }, [open, agents, agent]);

  // Default runtime to the first registered kind. If the registry returns
  // an empty list (server unreachable on mount), we leave it blank and
  // submit without a runtime field — the server will pick its default.
  useEffect(() => {
    if (open && runtimes.length > 0 && !runtimes.includes(runtime)) {
      setRuntime(runtimes[0] ?? "");
    }
  }, [open, runtimes, runtime]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!agent) return;
    onCreate(agent, runtime || undefined);
  };

  return (
    <Modal open={open} onClose={onClose} title="New session" size="default">
      <form onSubmit={onSubmit}>
        <div className="modal__body">
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
                <option key={a.agent.fqn} value={a.agent.fqn}>
                  {a.agent.fqn}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="new-session-runtime">
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Runtime
            </div>
            <select
              id="new-session-runtime"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
              disabled={busy || runtimes.length === 0}
              className="select select--full"
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
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            A new workdir will be created under{" "}
            <code>
              {workspaceDisplayName
                ? `<workspace:${workspaceDisplayName}>${pathSeparator}sessions${pathSeparator}<id>`
                : "<workspace>/sessions/<id>"}
            </code>{" "}
            and the agent will be baked into it.
          </p>
        </div>
        <div className="modal__footer">
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

// ─── Fallback modal ───────────────────────────────────────────

interface FallbackModalBodyProps {
  display: string;
  reason: string;
  onClose: () => void;
}

function FallbackModalBody({ display, reason, onClose }: FallbackModalBodyProps) {
  return (
    <>
      <div className="modal__body">
        <div className="muted" style={{ fontSize: 13 }}>
          We couldn't open a terminal automatically ({reason}). Run this command in your shell to
          start the session:
        </div>
        <CopyRow text={display} />
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}

// ─── Delete modal ─────────────────────────────────────────────

interface DeleteModalBodyProps {
  session: SessionRecord;
  purge: boolean;
  busy: boolean;
  onToggle: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteModalBody({
  session,
  purge,
  busy,
  onToggle,
  onCancel,
  onConfirm,
}: DeleteModalBodyProps) {
  const hasRuntimeState = session.runtimeSessionId !== null;
  return (
    <>
      <div className="modal__body">
        <p>
          Delete session <code>{session.id}</code> ({session.agent})?
        </p>
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0 0" }}>
          By default, the workdir at <code>{session.workdir}</code>
          {hasRuntimeState
            ? ` and the ${session.runtime} runtime state${
                session.runtimeSessionId ? ` (${session.runtimeSessionId.slice(0, 8)}…)` : ""
              }`
            : ""}{" "}
          {hasRuntimeState ? "are" : "is"} preserved on disk so you can recover later.
        </p>
        <label
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 10 }}
        >
          <input
            type="checkbox"
            checked={purge}
            onChange={(e) => onToggle(e.target.checked)}
            disabled={busy}
          />
          Also remove files {hasRuntimeState ? "and runtime state " : ""}(cannot be undone)
        </label>
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : purge ? "Delete and remove files" : "Delete"}
        </button>
      </div>
    </>
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

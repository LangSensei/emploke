import { type FormEvent, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  addWorkspace,
  type CatalogData,
  fetchAll,
  getConfig,
  getServerCurrentWorkspace,
  listWorkspaces,
  removeWorkspace,
  type ServerConfig,
  setActiveWorkspace,
  setServerCurrentWorkspace,
  updateWorkspaceMetadata,
  type WorkspaceListItem,
} from "./api";
import { PlusIcon, TrashIcon } from "./components/Icons";
import { Modal } from "./components/Modal";
import { type SectionDef, type SectionId, Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { CatalogPage, type CatalogTab } from "./pages/Catalog";
import { OverviewPage } from "./pages/Overview";
import { SessionsPage } from "./pages/Sessions";
import { SettingsPage } from "./pages/Settings";
import { TasksPage } from "./pages/Tasks";
import { startClockSync } from "./serverClock";

const SECTIONS: SectionDef[] = [
  { id: "overview", label: "Overview" },
  { id: "catalog", label: "Catalog" },
  { id: "sessions", label: "Sessions" },
  { id: "tasks", label: "Tasks" },
  { id: "settings", label: "Settings" },
];

const SECTION_TITLES: Record<SectionId, { title: string; crumb?: string }> = {
  overview: { title: "Overview", crumb: "System health" },
  catalog: { title: "Catalog", crumb: "Agents · Skills · MCPs" },
  sessions: { title: "Sessions", crumb: "Per-agent workdirs" },
  tasks: { title: "Tasks", crumb: "Autonomous agent runs" },
  settings: { title: "Settings", crumb: "Server & environment" },
};

const VALID_SECTIONS = new Set<SectionId>(["overview", "catalog", "sessions", "tasks", "settings"]);
const VALID_CATALOG_TABS = new Set<CatalogTab>(["agents", "skills", "mcps"]);

/**
 * Router host. Owns no state itself  every page's identity (workspace,
 * section, catalog tab) is encoded in the URL. Two browser tabs at
 * different URLs stay independent because there's no shared global state.
 *
 * The workspace identifier in the URL is the registry's UUID `wsId`; the
 * user-facing display name lives in `metadata.name` and may change at any
 * time without breaking links.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/workspaces/:wsId" element={<WorkspaceRedirect />} />
      <Route path="/workspaces/:wsId/catalog" element={<CatalogIndexRedirect />} />
      <Route path="/workspaces/:wsId/:section" element={<WorkspaceLayout />} />
      <Route path="/workspaces/:wsId/:section/:tab" element={<WorkspaceLayout />} />
      <Route path="*" element={<NotFoundRedirect />} />
    </Routes>
  );
}

/**
 * Hub landing page. Lists every registered workspace as a clickable card
 * (showing the user-chosen display name, not the UUID), plus an
 * "Add workspace" CTA. Acts as both the entry point (`/`) and the fallback
 * for any unknown URL  `*` redirects here. The server's last-opened
 * workspace is highlighted but never auto-navigated; the user always
 * picks. Keeps multi-tab usage predictable.
 */
function LandingPage() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[] | null>(null);
  const [recent, setRecent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [list, sc] = await Promise.all([
        listWorkspaces(),
        getServerCurrentWorkspace().catch(() => ({ id: null as string | null })),
      ]);
      setWorkspaces(list);
      setRecent(sc.id);
    } catch (e) {
      setError((e as Error).message);
      setWorkspaces([]);
    }
  }, []);

  // Clear the active-workspace slot whenever the landing page is shown so
  // any background API call from a stale layout doesn't leak across.
  useLayoutEffect(() => {
    setActiveWorkspace(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enterWorkspace = useCallback(
    (id: string) => {
      navigate(`/workspaces/${encodeURIComponent(id)}/overview`);
    },
    [navigate],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<WorkspaceListItem | null>(null);

  // Sort: recent first, then ok before broken, then by display name.
  const ordered = (workspaces ?? []).slice().sort((a, b) => {
    if (a.id === recent && b.id !== recent) return -1;
    if (b.id === recent && a.id !== recent) return 1;
    const aDisplay = a.name ?? a.id;
    const bDisplay = b.name ?? b.id;
    return aDisplay.localeCompare(bDisplay);
  });

  return (
    <div className="landing">
      <div className="landing__container">
        <header className="landing__hero">
          <div className="landing__logo" aria-hidden="true">
            E
          </div>
          <h1 className="landing__brand">emploke</h1>
          <p className="landing__tagline">Per-workspace agent orchestration</p>
        </header>

        {error && <div className="alert alert--error"> {error}</div>}

        <section className="landing__section">
          <div className="landing__section-header">
            <h2 className="landing__section-title">
              Workspaces
              {workspaces !== null && (
                <span className="landing__section-count">{workspaces.length}</span>
              )}
            </h2>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setError(null);
                setAddOpen(true);
              }}
            >
              <PlusIcon /> Add workspace
            </button>
          </div>

          {workspaces === null ? (
            <p className="muted">Loading</p>
          ) : workspaces.length === 0 ? (
            <div className="landing__empty">
              <p className="landing__empty-title">No workspaces registered yet</p>
              <p className="muted">
                A workspace is the project root that holds emploke's per-project sessions, catalog,
                tasks and workflows. Add one to get started.
              </p>
            </div>
          ) : (
            <div className="landing__grid">
              {ordered.map((ws) => {
                const display = ws.name ?? ws.id;
                const isRecent = ws.id === recent;
                const enter = () => {
                  enterWorkspace(ws.id);
                };
                return (
                  // biome-ignore lint/a11y/useSemanticElements: card has nested Remove <button>; nesting buttons is invalid HTML
                  <div
                    key={ws.id}
                    className="landing__card"
                    role="button"
                    tabIndex={0}
                    onClick={enter}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        enter();
                      }
                    }}
                    title={`Open ${display}`}
                  >
                    <div className="landing__card-row">
                      <span className="landing__card-name">{display}</span>
                      {isRecent && <span className="landing__card-badge">Recent</span>}
                    </div>
                    <div className="landing__card-path" title={ws.workdir}>
                      {ws.workdir}
                    </div>
                    <div className="landing__card-footer">
                      <span className="landing__card-meta">
                        {`Created ${formatLastOpened(ws.createdAt)}`}
                      </span>
                      <button
                        type="button"
                        className="landing__card-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          setError(null);
                          setRemoveTarget(ws);
                        }}
                        aria-label={`Remove ${display}`}
                        title={`Remove "${display}" from registry`}
                      >
                        <TrashIcon />
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <AddWorkspaceModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(id) => {
          setAddOpen(false);
          enterWorkspace(id);
        }}
      />

      <RemoveWorkspaceModal
        target={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onRemoved={async () => {
          setRemoveTarget(null);
          await refresh();
        }}
      />
    </div>
  );
}

interface AddWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

/**
 * Two-field form: absolute path + display name. Both required. Used in
 * place of two sequential window.prompt() dialogs which gave no chance
 * to revise the path after entering the name and looked out of place
 * compared to the rest of the dashboard.
 */
function AddWorkspaceModal({ open, onClose, onCreated }: AddWorkspaceModalProps) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset every time the modal opens so a previous failed attempt
  // doesn't leak its values into the next session.
  useEffect(() => {
    if (open) {
      setPath("");
      setName("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedPath = path.trim();
    const trimmedName = name.trim();
    if (trimmedPath === "" || trimmedName === "") {
      setError("Both path and display name are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await addWorkspace(trimmedPath, { name: trimmedName });
      onCreated(created.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add workspace">
      <form onSubmit={onSubmit}>
        <div className="modal__body">
          <div className="form-field">
            <label htmlFor="add-ws-path">Workspace directory</label>
            <input
              id="add-ws-path"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/absolute/path/to/workspace"
              // biome-ignore lint/a11y/noAutofocus: opens in response to a user click; auto-focusing the first field is expected UX
              autoFocus
              disabled={busy}
              required
            />
            <p className="form-hint">
              Absolute path on the <strong>server's</strong> filesystem. emploke will create
              <code> workspace.json</code> here if it doesn't exist.
            </p>
          </div>

          <div className="form-field">
            <label htmlFor="add-ws-name">Display name</label>
            <input
              id="add-ws-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme prod"
              disabled={busy}
              required
            />
            <p className="form-hint">Free-form text shown in the sidebar and on this page.</p>
          </div>

          {error && <div className="alert alert--error">⚠ {error}</div>}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || path.trim() === "" || name.trim() === ""}
          >
            {busy ? "Adding…" : "Add workspace"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface RemoveWorkspaceModalProps {
  target: WorkspaceListItem | null;
  onClose: () => void;
  onRemoved: () => void | Promise<void>;
}

/**
 * Confirmation dialog for DELETE /api/workspaces/:id. The destructive
 * action is intentionally a danger-style button so it stands out, but
 * the message also makes clear that the on-disk workspace files are
 * preserved — only the registry entry goes away.
 */
function RemoveWorkspaceModal({ target, onClose, onRemoved }: RemoveWorkspaceModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setBusy(false);
      setError(null);
    }
  }, [target]);

  if (!target) return null;
  const display = target.name ?? target.id;

  const onConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeWorkspace(target.id);
      await onRemoved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} title="Remove workspace">
      <div className="modal__body">
        <p>
          Remove <code>{display}</code> from emploke?
        </p>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Path: <code>{target.workdir}</code>
        </p>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          The workspace files on disk are kept untouched. Only emploke's metadata (the registry
          entry and <code>workspace.json</code>) is removed. You can re-add this path later.
        </p>
        {error && <div className="alert alert--error">⚠ {error}</div>}
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
    </Modal>
  );
}

/** `/workspaces/<uuid>`  `/workspaces/<uuid>/overview`. */
function WorkspaceRedirect() {
  const { wsId } = useParams<{ wsId: string }>();
  return <Navigate to={`/workspaces/${encodeURIComponent(wsId ?? "")}/overview`} replace />;
}

/** `/workspaces/<uuid>/catalog`  `/workspaces/<uuid>/catalog/agents`. */
function CatalogIndexRedirect() {
  const { wsId } = useParams<{ wsId: string }>();
  return <Navigate to={`/workspaces/${encodeURIComponent(wsId ?? "")}/catalog/agents`} replace />;
}

function NotFoundRedirect() {
  return <Navigate to="/" replace />;
}

function formatLastOpened(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.round(diff / min)} min ago`;
  if (diff < day) return `${Math.round(diff / hour)} h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)} d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * The workspace-scoped shell. Owns Sidebar/TopBar/content; pulls workspace
 * id + section + catalog tab from the URL via useParams. All API calls are
 * gated on a valid workspace via `setActiveWorkspace`, which is invoked
 * synchronously during render through useLayoutEffect so child effects
 * see the new value before they fire their first fetch.
 */
function WorkspaceLayout() {
  const params = useParams<{ wsId: string; section?: string; tab?: string }>();
  const navigate = useNavigate();
  const wsId = params.wsId ?? "";
  const sectionParam = params.section ?? "overview";
  const sectionIsValid = VALID_SECTIONS.has(sectionParam as SectionId);
  const section: SectionId = (sectionIsValid ? sectionParam : "overview") as SectionId;
  const tabParam = params.tab ?? "agents";
  const tabIsValid = VALID_CATALOG_TABS.has(tabParam as CatalogTab);
  const catalogTab: CatalogTab = (tabIsValid ? tabParam : "agents") as CatalogTab;

  // null = still loading; [] = loaded with zero workspaces; otherwise loaded.
  // Used both for rendering the sidebar and for detecting an unknown wsId.
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[] | null>(null);
  const [data, setData] = useState<CatalogData>({
    overview: null,
    skills: [],
    agents: [],
    mcps: [],
  });
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Sync the URL's wsId into the api module's active-workspace slot
  // BEFORE any child effect fires (useLayoutEffect runs before useEffect),
  // so the catalog/sessions fetches that follow read the right workspace.
  useLayoutEffect(() => {
    setActiveWorkspace(wsId || null);
    return () => setActiveWorkspace(null);
  }, [wsId]);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const list = await listWorkspaces();
      setWorkspaces(list);
    } catch (e) {
      setError((e as Error).message);
      // Mark "load attempted" even on failure so the unknown-wsId check
      // below can fire  falling back to landing is safer than spinning.
      setWorkspaces([]);
    }
  }, []);

  const refreshData = useCallback(async () => {
    try {
      setError(null);
      const next = await fetchAll();
      setData(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Whenever the URL workspace changes, refetch the workspace list AND
  // the workspace-scoped catalog. We trigger both in parallel; the list
  // fetch only depends on the registry, the data fetch on the active
  // workspace which useLayoutEffect already updated above.
  useEffect(() => {
    if (!wsId) return;
    void refreshWorkspaces();
    void refreshData();
    // Best-effort: tell the server "this is my preferred landing
    // workspace next time someone hits `/`." Multi-tab safe  there's no
    // longer a single-tab "current" that other tabs depend on.
    setServerCurrentWorkspace(wsId).catch(() => {
      // ignore: the URL is already authoritative for this tab
    });
  }, [wsId, refreshWorkspaces, refreshData]);

  // Server config is static for the lifetime of the server process.
  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch(() => {
        // Non-fatal: pages that need config will render placeholders.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync the dashboard's clock skew against the server periodically.
  // serverNow() is then used by Tasks/Sessions presets ("Today", "7d",
  // "30d") so the createdSince cutoff matches what the server actually
  // sees, even if the user's laptop clock has drifted. See
  // ./serverClock.ts for the rationale.
  useEffect(() => startClockSync(), []);

  const navigateToSection = useCallback(
    (next: SectionId) => {
      navigate(buildWorkspacePath(wsId, next, "agents"));
    },
    [navigate, wsId],
  );

  const navigateToCatalogTab = useCallback(
    (next: CatalogTab) => {
      navigate(`/workspaces/${encodeURIComponent(wsId)}/catalog/${next}`);
    },
    [navigate, wsId],
  );

  const handleSelectWorkspace = useCallback(
    (id: string) => {
      // Preserve the active section (and catalog tab) when switching
      // workspaces  the user cares about "show me the same view in
      // workspace B" most of the time.
      navigate(buildWorkspacePath(id, section, catalogTab));
    },
    [navigate, section, catalogTab],
  );

  const handleAddWorkspace = useCallback(() => {
    setError(null);
    setAddOpen(true);
  }, []);

  const handleRenameWorkspace = useCallback(
    async (id: string, newDisplayName: string) => {
      // PATCHes only workspace.json metadata; the URL key (id) is opaque
      // and stable, so existing URLs continue to work.
      await updateWorkspaceMetadata(id, { name: newDisplayName });
      await refreshWorkspaces();
    },
    [refreshWorkspaces],
  );

  const meta = SECTION_TITLES[section];
  const titleSuffix = section === "catalog" ? ` / ${capitalize(catalogTab)}` : "";

  //  URL validation guards (after all hooks; avoid hooks-count drift)
  // 1. Unknown workspace id  bounce to landing.
  if (workspaces !== null && wsId && !workspaces.some((w) => w.id === wsId)) {
    return <Navigate to="/" replace />;
  }
  // 2. Section in URL but not a known section  bounce to landing.
  //    (We can't silently coerce to "overview" without lying about the URL.)
  if (params.section !== undefined && !sectionIsValid) {
    return <Navigate to="/" replace />;
  }
  // 3. Catalog tab in URL but not a known tab  bounce to landing.
  if (section === "catalog" && params.tab !== undefined && !tabIsValid) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="shell">
      <Sidebar
        sections={SECTIONS}
        active={section}
        onSelect={navigateToSection}
        workspaces={workspaces ?? []}
        currentWorkspaceId={wsId}
        onSelectWorkspace={handleSelectWorkspace}
        onAddWorkspace={handleAddWorkspace}
        onRenameWorkspace={handleRenameWorkspace}
      />

      <div className="main">
        <TopBar
          title={meta.title + titleSuffix}
          {...(meta.crumb !== undefined ? { crumb: meta.crumb } : {})}
        />

        <div className="content">
          {error && <div className="alert alert--error"> {error}</div>}

          {section === "overview" && <OverviewPage overview={data.overview} />}

          {section === "catalog" && (
            <CatalogPage
              tab={catalogTab}
              onTabChange={navigateToCatalogTab}
              skills={data.skills}
              agents={data.agents}
              mcps={data.mcps}
              currentWorkspaceId={wsId}
              onChanged={refreshData}
            />
          )}

          {section === "sessions" && (
            <SessionsPage
              agents={data.agents}
              config={config}
              currentWorkspaceId={wsId}
              workspaces={workspaces ?? []}
            />
          )}

          {section === "tasks" && (
            <TasksPage agents={data.agents} currentWorkspaceId={wsId} config={config} />
          )}

          {section === "settings" && (
            <SettingsPage
              serverUrl={typeof window !== "undefined" ? window.location.origin : ""}
              config={config}
              currentWorkspaceId={wsId}
              workspaces={workspaces ?? []}
            />
          )}
        </div>
      </div>

      <AddWorkspaceModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={async (id) => {
          setAddOpen(false);
          // Refresh the registry list so the sidebar dropdown picks up the
          // new entry, then jump into it preserving the current section/tab.
          await refreshWorkspaces();
          navigate(buildWorkspacePath(id, section, catalogTab));
        }}
      />
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build a URL for a workspace+section. For Catalog, always include the tab
 * segment so we never land on the bare `/catalog` URL (which would re-render
 * the Catalog page with the default tab anyway, but produces an ugly URL).
 */
function buildWorkspacePath(wsId: string, section: SectionId, catalogTab: CatalogTab): string {
  const base = `/workspaces/${encodeURIComponent(wsId)}/${section}`;
  return section === "catalog" ? `${base}/${catalogTab}` : base;
}

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
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
import { type SectionDef, type SectionId, Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { CatalogPage, type CatalogTab } from "./pages/Catalog";
import { ComingSoonPage } from "./pages/ComingSoon";
import { OverviewPage } from "./pages/Overview";
import { SessionsPage } from "./pages/Sessions";
import { SettingsPage } from "./pages/Settings";

const SECTIONS: SectionDef[] = [
  { id: "overview", label: "Overview" },
  { id: "catalog", label: "Catalog" },
  { id: "sessions", label: "Sessions" },
  { id: "substrates", label: "Substrates", badge: "soon", disabled: true },
  { id: "settings", label: "Settings" },
];

const SECTION_TITLES: Record<SectionId, { title: string; crumb?: string }> = {
  overview: { title: "Overview", crumb: "System health" },
  catalog: { title: "Catalog", crumb: "Agents  Skills  MCPs" },
  sessions: { title: "Sessions", crumb: "Per-agent workdirs" },
  substrates: { title: "Substrates", crumb: "Compute backends" },
  settings: { title: "Settings", crumb: "Server & environment" },
};

const VALID_SECTIONS = new Set<SectionId>([
  "overview",
  "catalog",
  "sessions",
  "substrates",
  "settings",
]);
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
  const [busy, setBusy] = useState(false);

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

  const onAdd = useCallback(async () => {
    const pathInput = window.prompt(
      "Workspace directory (absolute path). emploke will create workspace.json here if it doesn't exist.",
    );
    if (!pathInput || pathInput.trim() === "") return;
    const nameInput = window.prompt(
      "Display name for this workspace (free-form text, shown in the sidebar). Required.",
    );
    if (!nameInput || nameInput.trim() === "") {
      setError("add workspace: a display name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await addWorkspace(pathInput.trim(), { name: nameInput.trim() });
      navigate(`/workspaces/${encodeURIComponent(created.id)}/overview`);
    } catch (e) {
      setError(`add workspace: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [navigate]);

  // Remove from registry only — files on disk (workspace.json, sessions/,
  // catalog/, .lock, etc.) are intentionally left intact, matching the
  // server's DELETE semantics. The user can always re-add the same path.
  const onRemove = useCallback(
    async (ws: WorkspaceListItem) => {
      const display = ws.metadata?.name ?? ws.id;
      const ok = window.confirm(
        `Remove "${display}" from emploke?\n\n` +
          `Path: ${ws.path}\n\n` +
          `The workspace files on disk are kept untouched — only the registry entry ` +
          `is removed. You can re-add this path later.`,
      );
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        await removeWorkspace(ws.id);
        await refresh();
      } catch (e) {
        setError(`remove workspace: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Sort: recent first, then ok before broken, then by display name.
  const ordered = (workspaces ?? []).slice().sort((a, b) => {
    if (a.id === recent && b.id !== recent) return -1;
    if (b.id === recent && a.id !== recent) return 1;
    const aBad = a.status !== "ok";
    const bBad = b.status !== "ok";
    if (aBad !== bBad) return aBad ? 1 : -1;
    const aDisplay = a.metadata?.name ?? a.id;
    const bDisplay = b.metadata?.name ?? b.id;
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
            <button type="button" className="btn btn--primary" onClick={onAdd} disabled={busy}>
              <PlusIcon /> {busy ? "Adding" : "Add workspace"}
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
                const display = ws.metadata?.name ?? ws.id;
                const isRecent = ws.id === recent;
                const broken = ws.status !== "ok";
                const enter = () => {
                  if (!broken) enterWorkspace(ws.id);
                };
                return (
                  // biome-ignore lint/a11y/useSemanticElements: card has nested Remove <button>; nesting buttons is invalid HTML
                  <div
                    key={ws.id}
                    className={`landing__card${broken ? " landing__card--broken" : ""}`}
                    role="button"
                    tabIndex={broken ? -1 : 0}
                    aria-disabled={broken}
                    onClick={enter}
                    onKeyDown={(e) => {
                      if (broken) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        enter();
                      }
                    }}
                    title={broken ? (ws.reason ?? ws.status) : `Open ${display}`}
                  >
                    <div className="landing__card-row">
                      <span className="landing__card-name">{display}</span>
                      {isRecent && !broken && <span className="landing__card-badge">Recent</span>}
                      {broken && (
                        <span className="landing__card-badge landing__card-badge--warn">
                          {ws.status}
                        </span>
                      )}
                    </div>
                    <div className="landing__card-path" title={ws.path}>
                      {ws.path}
                    </div>
                    <div className="landing__card-footer">
                      <span className="landing__card-meta">
                        {ws.lastOpenedAt ? `Last opened ${formatLastOpened(ws.lastOpenedAt)}` : ""}
                      </span>
                      <button
                        type="button"
                        className="landing__card-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onRemove(ws);
                        }}
                        disabled={busy}
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
    </div>
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

  const handleAddWorkspace = useCallback(async () => {
    const pathInput = window.prompt(
      "Workspace directory (absolute path). emploke will create workspace.json here if it doesn't exist.",
    );
    if (!pathInput || pathInput.trim() === "") return;
    const nameInput = window.prompt(
      "Display name for this workspace (free-form text, shown in the sidebar). Required.",
    );
    if (!nameInput || nameInput.trim() === "") {
      setError("add workspace: a display name is required");
      return;
    }
    try {
      const created = await addWorkspace(pathInput.trim(), { name: nameInput.trim() });
      await refreshWorkspaces();
      navigate(buildWorkspacePath(created.id, section, catalogTab));
    } catch (e) {
      setError(`add workspace: ${(e as Error).message}`);
    }
  }, [navigate, refreshWorkspaces, section, catalogTab]);

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

          {section === "substrates" && (
            <ComingSoonPage
              title="Substrates"
              description="Compute backends that execute resolved skill/agent dependencies."
              hint="Will host runtime adapters (e.g. Copilot CLI, Claude Code, local subprocess)."
            />
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

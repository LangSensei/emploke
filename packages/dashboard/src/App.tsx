import { useCallback, useEffect, useState } from "react";
import {
  addWorkspace,
  type CatalogData,
  fetchAll,
  getConfig,
  getCurrentWorkspace,
  getServerCurrentWorkspace,
  listWorkspaces,
  type ServerConfig,
  setCurrentWorkspace,
  setServerCurrentWorkspace,
  type WorkspaceListItem,
} from "./api";
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
  catalog: { title: "Catalog", crumb: "Agents · Skills · MCPs" },
  sessions: { title: "Sessions", crumb: "Per-agent workdirs" },
  substrates: { title: "Substrates", crumb: "Compute backends" },
  settings: { title: "Settings", crumb: "Server & environment" },
};

export function App() {
  const [section, setSection] = useState<SectionId>("overview");
  const [catalogTab, setCatalogTab] = useState<CatalogTab>("agents");
  const [data, setData] = useState<CatalogData>({
    overview: null,
    skills: [],
    agents: [],
    mcps: [],
  });
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
  const [currentWs, setCurrentWs] = useState<string | null>(getCurrentWorkspace());

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const next = await fetchAll();
      setData(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  /**
   * Reconcile the workspace selection between the registry, the server's
   * "currentName", and our localStorage:
   *   1. Pull the registry list.
   *   2. If localStorage already names a registered workspace, keep it.
   *   3. Otherwise prefer the server's currentName (so a freshly-cleared
   *      browser still opens the right workspace).
   *   4. Otherwise fall back to the first registered workspace.
   *   5. Persist back to localStorage so subsequent api calls have a value.
   */
  const refreshWorkspaces = useCallback(async () => {
    try {
      const list = await listWorkspaces();
      setWorkspaces(list);

      const ls = getCurrentWorkspace();
      let selected: string | null = null;
      if (ls && list.some((w) => w.name === ls)) {
        selected = ls;
      } else {
        let serverCurrent: string | null = null;
        try {
          serverCurrent = (await getServerCurrentWorkspace()).name;
        } catch {
          // server may not yet be ready; defaulting to first entry below
        }
        if (serverCurrent && list.some((w) => w.name === serverCurrent)) {
          selected = serverCurrent;
        } else if (list.length > 0) {
          selected = list[0]!.name;
        }
        if (selected) setCurrentWorkspace(selected);
      }
      setCurrentWs(selected);
    } catch (e) {
      // Workspace list is best-effort; the rest of the dashboard can
      // still function for catalog browsing.
      setError((e as Error).message);
    }
  }, []);

  const handleSelectWorkspace = useCallback(async (name: string) => {
    setCurrentWorkspace(name);
    setCurrentWs(name);
    try {
      await setServerCurrentWorkspace(name);
    } catch {
      // server-side currentName is just a hint; ignore failures
    }
  }, []);

  const handleAddWorkspace = useCallback(async () => {
    const pathInput = window.prompt(
      "Workspace directory (absolute path). emploke will create workspace.json here if it doesn't exist.",
    );
    if (!pathInput || pathInput.trim() === "") return;
    const nameInput = window.prompt(
      "Workspace name (kebab-case, used in URLs). Leave blank to use the directory's basename.",
    );
    try {
      const opts: { name?: string } = {};
      if (nameInput && nameInput.trim() !== "") opts.name = nameInput.trim();
      const created = await addWorkspace(pathInput.trim(), opts);
      await refreshWorkspaces();
      handleSelectWorkspace(created.name);
    } catch (e) {
      setError(`add workspace: ${(e as Error).message}`);
    }
  }, [refreshWorkspaces, handleSelectWorkspace]);

  // Server config is static for the lifetime of the server process; one
  // fetch on mount is enough. Soft-fails to null so the UI degrades to
  // showing "—" for paths it doesn't yet know.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    refresh();
    refreshWorkspaces();
  }, []);

  const meta = SECTION_TITLES[section];
  const titleSuffix = section === "catalog" ? ` / ${capitalize(catalogTab)}` : "";

  return (
    <div className="shell">
      <Sidebar sections={SECTIONS} active={section} onSelect={setSection} />

      <div className="main">
        <TopBar
          title={meta.title + titleSuffix}
          {...(meta.crumb !== undefined ? { crumb: meta.crumb } : {})}
          workspaces={workspaces}
          currentWorkspace={currentWs}
          onSelectWorkspace={handleSelectWorkspace}
          onAddWorkspace={handleAddWorkspace}
        />

        <div className="content">
          {error && <div className="alert alert--error">⚠️ {error}</div>}

          {section === "overview" && <OverviewPage overview={data.overview} />}

          {section === "catalog" && (
            <CatalogPage
              tab={catalogTab}
              onTabChange={setCatalogTab}
              skills={data.skills}
              agents={data.agents}
              mcps={data.mcps}
              onChanged={refresh}
            />
          )}

          {section === "sessions" && (
            <SessionsPage agents={data.agents} config={config} currentWorkspace={currentWs} />
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
              serverUrl={typeof window !== "undefined" ? window.location.origin : "—"}
              config={config}
              currentWorkspace={currentWs}
              workspaces={workspaces}
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

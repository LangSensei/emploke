import { useEffect, useState } from "react";
import { type CatalogData, fetchAll, getConfig, type ServerConfig } from "./api";
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

  const refresh = async () => {
    try {
      setError(null);
      const next = await fetchAll();
      setData(next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
  }, []);

  const meta = SECTION_TITLES[section];
  const titleSuffix = section === "catalog" ? ` / ${capitalize(catalogTab)}` : "";

  return (
    <div className="shell">
      <Sidebar sections={SECTIONS} active={section} onSelect={setSection} />

      <div className="main">
        <TopBar title={meta.title + titleSuffix} crumb={meta.crumb} />

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

          {section === "sessions" && <SessionsPage agents={data.agents} config={config} />}

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

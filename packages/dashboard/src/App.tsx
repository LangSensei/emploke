import { useEffect, useState } from "react";
import { type CatalogData, fetchAll } from "./api";
import { type SectionDef, type SectionId, Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { CatalogPage, type CatalogTab } from "./pages/Catalog";
import { ComingSoonPage } from "./pages/ComingSoon";
import { OverviewPage } from "./pages/Overview";
import { SettingsPage } from "./pages/Settings";

const SECTIONS: SectionDef[] = [
  { id: "overview", label: "Overview", icon: "🏠" },
  { id: "catalog", label: "Catalog", icon: "📚" },
  { id: "sessions", label: "Sessions", icon: "⚡", badge: "soon", disabled: true },
  { id: "substrates", label: "Substrates", icon: "🖥️", badge: "soon", disabled: true },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

const SECTION_TITLES: Record<SectionId, { title: string; crumb?: string }> = {
  overview: { title: "Overview", crumb: "System health" },
  catalog: { title: "Catalog", crumb: "Skills · Agents · MCPs" },
  sessions: { title: "Sessions", crumb: "Task execution history" },
  substrates: { title: "Substrates", crumb: "Compute backends" },
  settings: { title: "Settings", crumb: "Server & environment" },
};

export function App() {
  const [section, setSection] = useState<SectionId>("overview");
  const [catalogTab, setCatalogTab] = useState<CatalogTab>("skills");
  const [data, setData] = useState<CatalogData>({
    overview: null,
    skills: [],
    agents: [],
    mcps: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setError(null);
      const next = await fetchAll();
      setData(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

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
        <TopBar
          title={meta.title + titleSuffix}
          crumb={meta.crumb}
          onRefresh={refresh}
          refreshing={refreshing}
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
            />
          )}

          {section === "sessions" && (
            <ComingSoonPage
              title="Sessions"
              description="Track running and completed task executions across substrates."
              hint="Will surface lifecycle events from the catalog event bus."
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
              serverUrl={typeof window !== "undefined" ? window.location.origin : "—"}
              catalogCounts={
                data.overview
                  ? {
                      skills: data.overview.counts.skills,
                      agents: data.overview.counts.agents,
                      mcps: data.overview.counts.mcps,
                    }
                  : undefined
              }
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

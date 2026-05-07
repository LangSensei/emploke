import type { AgentEntry, SkillEntry } from "@emploke/catalog";
import type { McpItem } from "../api";
import { EntryTable } from "../components/EntryTable";

export type CatalogTab = "skills" | "agents" | "mcps";

interface CatalogProps {
  tab: CatalogTab;
  onTabChange: (tab: CatalogTab) => void;
  skills: SkillEntry[];
  agents: AgentEntry[];
  mcps: McpItem[];
}

export function CatalogPage({ tab, onTabChange, skills, agents, mcps }: CatalogProps) {
  return (
    <div>
      <nav className="section-tabs">
        <button
          type="button"
          className={tab === "skills" ? "active" : ""}
          onClick={() => onTabChange("skills")}
        >
          Skills <span className="count">{skills.length}</span>
        </button>
        <button
          type="button"
          className={tab === "agents" ? "active" : ""}
          onClick={() => onTabChange("agents")}
        >
          Agents <span className="count">{agents.length}</span>
        </button>
        <button
          type="button"
          className={tab === "mcps" ? "active" : ""}
          onClick={() => onTabChange("mcps")}
        >
          MCPs <span className="count">{mcps.length}</span>
        </button>
      </nav>

      {tab === "skills" && (
        <EntryTable
          items={skills.map((s) => ({
            name: s.skill.name,
            description: s.skill.description,
            version: s.skill.version,
            status: s.status,
            missingDeps: s.missingDeps,
          }))}
          emptyTitle="No skills installed"
          emptyHint={
            <>
              Install one with <code>emploke skill install &lt;dir&gt;</code> from the CLI.
            </>
          }
        />
      )}

      {tab === "agents" && (
        <EntryTable
          items={agents.map((a) => ({
            name: a.agent.name,
            description: a.agent.description,
            version: a.agent.version,
            status: a.status,
            missingDeps: a.missingDeps,
          }))}
          emptyTitle="No agents installed"
          emptyHint={<>Agents wrap skills + MCPs into runnable templates.</>}
        />
      )}

      {tab === "mcps" && <McpList mcps={mcps} />}
    </div>
  );
}

function McpList({ mcps }: { mcps: McpItem[] }) {
  if (mcps.length === 0) {
    return (
      <div className="empty">
        <div className="empty__icon">∅</div>
        <h3 className="empty__title">No MCPs installed</h3>
        <p className="empty__hint">MCPs are JSON server configs referenced by skills/agents.</p>
      </div>
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Path</th>
        </tr>
      </thead>
      <tbody>
        {mcps.map((m) => (
          <tr key={m.name}>
            <td className="name-cell">{m.name}</td>
            <td className="desc-cell mono" style={{ fontSize: 12 }}>
              {m.path ?? <em>—</em>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

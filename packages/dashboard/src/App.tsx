import type { AgentEntry, SkillEntry } from "@emploke/catalog";
import { useEffect, useState } from "react";

interface Overview {
  counts: { skills: number; agents: number; mcps: number; disabled: number };
  issues: { path: string; reason: string }[];
}

interface McpItem {
  name: string;
  path: string | null;
}

export function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [mcps, setMcps] = useState<McpItem[]>([]);
  const [tab, setTab] = useState<"overview" | "skills" | "agents" | "mcps">("overview");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const [ov, sk, ag, mc] = await Promise.all([
        fetch("/api/overview").then((r) => {
          if (!r.ok) throw new Error(`overview: ${r.status}`);
          return r.json();
        }),
        fetch("/api/skills").then((r) => {
          if (!r.ok) throw new Error(`skills: ${r.status}`);
          return r.json();
        }),
        fetch("/api/agents").then((r) => {
          if (!r.ok) throw new Error(`agents: ${r.status}`);
          return r.json();
        }),
        fetch("/api/mcps").then((r) => {
          if (!r.ok) throw new Error(`mcps: ${r.status}`);
          return r.json();
        }),
      ]);
      setOverview(ov);
      setSkills(sk);
      setAgents(ag);
      setMcps(mc);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <h1>🔮 Emploke Dashboard</h1>

      {error && (
        <div
          style={{
            padding: 12,
            marginBottom: 16,
            background: "#fed7d7",
            borderRadius: 8,
            color: "#c53030",
          }}
        >
          ⚠️ {error}
        </div>
      )}

      <nav style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        {(["overview", "skills", "agents", "mcps"] as const).map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => setTab(t)}
            style={{ fontWeight: tab === t ? "bold" : "normal", padding: "6px 12px" }}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
        <button type="button" onClick={refresh} style={{ marginLeft: "auto", padding: "6px 12px" }}>
          ↻ Refresh
        </button>
      </nav>

      {tab === "overview" && overview && (
        <div>
          <h2>Overview</h2>
          <div style={{ display: "flex", gap: 24 }}>
            <Stat label="Skills" value={overview.counts.skills} />
            <Stat label="Agents" value={overview.counts.agents} />
            <Stat label="MCPs" value={overview.counts.mcps} />
            <Stat label="Disabled" value={overview.counts.disabled} warn />
          </div>
          {overview.issues.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h3>⚠️ Scan Issues</h3>
              <ul>
                {overview.issues.map((i) => (
                  <li key={i.path}>
                    <code>{i.path}</code> — {i.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === "skills" && (
        <div>
          <h2>Skills</h2>
          <EntryTable
            items={skills.map((s) => ({
              name: s.skill.name,
              description: s.skill.description,
              version: s.skill.version,
              status: s.status,
              missingDeps: s.missingDeps,
            }))}
          />
        </div>
      )}

      {tab === "agents" && (
        <div>
          <h2>Agents</h2>
          <EntryTable
            items={agents.map((a) => ({
              name: a.agent.name,
              description: a.agent.description,
              version: a.agent.version,
              status: a.status,
              missingDeps: a.missingDeps,
            }))}
          />
        </div>
      )}

      {tab === "mcps" && <McpList mcps={mcps} />}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: 16,
        border: "1px solid #ddd",
        borderRadius: 8,
        minWidth: 100,
      }}
    >
      <div style={{ fontSize: 32, color: warn && value > 0 ? "#e53e3e" : "#333" }}>{value}</div>
      <div style={{ fontSize: 14, color: "#666" }}>{label}</div>
    </div>
  );
}

function EntryTable({
  items,
}: {
  items: {
    name: string;
    description: string;
    version: string;
    status: "ready" | "disabled";
    missingDeps?: readonly string[];
  }[];
}) {
  if (items.length === 0) return <p style={{ color: "#666" }}>No entries.</p>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ borderBottom: "2px solid #ddd", textAlign: "left" }}>
          <th style={{ padding: 8 }}>Name</th>
          <th style={{ padding: 8 }}>Description</th>
          <th style={{ padding: 8 }}>Version</th>
          <th style={{ padding: 8 }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.name} style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: 8, fontFamily: "monospace" }}>{item.name}</td>
            <td style={{ padding: 8 }}>{item.description}</td>
            <td style={{ padding: 8 }}>{item.version}</td>
            <td style={{ padding: 8 }}>
              {item.status === "ready" ? (
                "✅"
              ) : (
                <span title={item.missingDeps?.join(", ")}>⛔ disabled</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function McpList({ mcps }: { mcps: McpItem[] }) {
  return (
    <div>
      <h2>MCPs</h2>
      {mcps.length === 0 ? (
        <p style={{ color: "#666" }}>No MCPs installed.</p>
      ) : (
        <ul>
          {mcps.map((m) => (
            <li key={m.name}>
              <code>{m.name}</code> — <span style={{ fontSize: 12, color: "#888" }}>{m.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import type { AgentEntry, SkillEntry } from "@emploke/catalog";

export interface OverviewData {
  counts: {
    skills: number;
    agents: number;
    mcps: number;
    disabled: number;
  };
  issues: {
    path: string;
    reason: string;
  }[];
}

export interface McpItem {
  name: string;
  path: string | null;
}

export interface CatalogData {
  overview: OverviewData | null;
  skills: SkillEntry[];
  agents: AgentEntry[];
  mcps: McpItem[];
}

const fetchJson = async <T>(path: string, label: string): Promise<T> => {
  const r = await fetch(path);
  if (!r.ok) {
    throw new Error(`${label}: ${r.status}`);
  }
  return r.json() as Promise<T>;
};

export async function fetchAll(): Promise<CatalogData> {
  const [overview, skills, agents, mcps] = await Promise.all([
    fetchJson<OverviewData>("/api/overview", "overview"),
    fetchJson<SkillEntry[]>("/api/skills", "skills"),
    fetchJson<AgentEntry[]>("/api/agents", "agents"),
    fetchJson<McpItem[]>("/api/mcps", "mcps"),
  ]);
  return { overview, skills, agents, mcps };
}

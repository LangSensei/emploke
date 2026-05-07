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

// ─── Mutations ────────────────────────────────────────────────────

const mutate = async (path: string, init: RequestInit): Promise<void> => {
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const body = await r.json();
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      // body not JSON; keep status
    }
    throw new Error(msg);
  }
};

const jsonInit = (method: string, body: object): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const installAgent = (sourcePath: string) =>
  mutate("/api/agents", jsonInit("POST", { sourcePath }));

export const installSkill = (sourcePath: string) =>
  mutate("/api/skills", jsonInit("POST", { sourcePath }));

export const installMcp = (sourcePath: string, name?: string) =>
  mutate("/api/mcps", jsonInit("POST", name ? { sourcePath, name } : { sourcePath }));

export const removeAgent = (name: string) =>
  mutate(`/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" });

export const removeSkill = (name: string) =>
  mutate(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });

export const removeMcp = (name: string) =>
  mutate(`/api/mcps/${encodeURIComponent(name)}`, { method: "DELETE" });

export interface McpDetail {
  name: string;
  path: string | null;
  content: unknown;
}

export const getMcp = (name: string): Promise<McpDetail> =>
  fetchJson<McpDetail>(`/api/mcps/${encodeURIComponent(name)}`, "mcp");

export const updateMcpContent = (name: string, content: unknown) =>
  mutate(`/api/mcps/${encodeURIComponent(name)}`, jsonInit("PUT", { content }));

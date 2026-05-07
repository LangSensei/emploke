import type { AgentEntry, MissingDep, SkillEntry } from "@emploke/catalog";

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
  /** Raw JSON content as stored on disk (preserves user formatting). */
  content: string;
}

export const getMcp = (name: string): Promise<McpDetail> =>
  fetchJson<McpDetail>(`/api/mcps/${encodeURIComponent(name)}`, "mcp");

export const updateMcpContent = (name: string, content: string) =>
  mutate(`/api/mcps/${encodeURIComponent(name)}`, jsonInit("PUT", { content }));

export interface MarkdownDetail {
  content: string;
}

export interface SkillDetail {
  skill: import("@emploke/catalog").Skill;
  status: "ready" | "disabled";
  missingDeps?: MissingDep[];
  content: string;
}

export const getSkill = (name: string): Promise<SkillDetail> =>
  fetchJson<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`, "skill");

export const getSkillContent = (name: string): Promise<string> =>
  getSkill(name).then((d) => d.content);

export const updateSkillContent = (name: string, content: string) =>
  mutate(`/api/skills/${encodeURIComponent(name)}`, jsonInit("PUT", { content }));

export interface SkillMetadataPatch {
  description?: string;
  version?: string;
  prereqs?: string | null;
  dependencies?: { skills?: string[]; mcps?: string[] } | null;
}

export const patchSkillMetadata = (name: string, patch: SkillMetadataPatch) =>
  mutate(`/api/skills/${encodeURIComponent(name)}`, jsonInit("PATCH", patch));

export interface AgentDetail {
  agent: import("@emploke/catalog").Agent;
  status: "ready" | "disabled";
  missingDeps?: MissingDep[];
  content: string;
}

export const getAgent = (name: string): Promise<AgentDetail> =>
  fetchJson<AgentDetail>(`/api/agents/${encodeURIComponent(name)}`, "agent");

export const getAgentContent = (name: string): Promise<string> =>
  getAgent(name).then((d) => d.content);

export const updateAgentContent = (name: string, content: string) =>
  mutate(`/api/agents/${encodeURIComponent(name)}`, jsonInit("PUT", { content }));

export interface AgentMetadataPatch {
  description?: string;
  version?: string;
  dependencies?: { skills?: string[]; mcps?: string[] } | null;
}

export const patchAgentMetadata = (name: string, patch: AgentMetadataPatch) =>
  mutate(`/api/agents/${encodeURIComponent(name)}`, jsonInit("PATCH", patch));

// ─── Sessions ─────────────────────────────────────────────────────

export interface CopilotSessionInfo {
  sessionId: string;
  name?: string;
  summary?: string;
  /** ISO 8601 string. */
  createdAt?: string;
  /** ISO 8601 string. */
  updatedAt?: string;
}

export interface SessionRecord {
  id: string;
  workdir: string;
  agent: string;
  catalogDir?: string;
  /** ISO 8601 string. */
  createdAt: string;
  copilotSessions: CopilotSessionInfo[];
  latestCopilotSession: CopilotSessionInfo | null;
}

export interface LaunchCommand {
  cmd: string;
  args: string[];
  cwd: string;
  display: string;
}

export const listSessions = (agent?: string): Promise<SessionRecord[]> => {
  const qs = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  return fetchJson<SessionRecord[]>(`/api/sessions${qs}`, "sessions");
};

export const getSession = (id: string): Promise<SessionRecord> =>
  fetchJson<SessionRecord>(`/api/sessions/${encodeURIComponent(id)}`, "session");

export const createSession = async (agent: string): Promise<SessionRecord> => {
  const r = await fetch("/api/sessions", jsonInit("POST", { agent }));
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
  return (await r.json()) as SessionRecord;
};

export const deleteSession = (id: string, deleteCopilotState = false) => {
  const qs = deleteCopilotState ? "?deleteCopilotState=1" : "";
  return mutate(`/api/sessions/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
};

export const getLaunchCommand = (id: string): Promise<LaunchCommand> =>
  fetchJson<LaunchCommand>(
    `/api/sessions/${encodeURIComponent(id)}/launch-command`,
    "launch-command",
  );

export const getResumeCommand = (id: string, copilotSessionId: string): Promise<LaunchCommand> =>
  fetchJson<LaunchCommand>(
    `/api/sessions/${encodeURIComponent(id)}/resume-command/${encodeURIComponent(copilotSessionId)}`,
    "resume-command",
  );

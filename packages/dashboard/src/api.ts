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

// ─── Workspace identity ───────────────────────────────────────────
//
// All session-scoped requests are routed through `/api/workspaces/<name>/...`
// where <name> is the current workspace's URL identifier. The dashboard
// remembers the user's selection in localStorage; api helpers below pull
// the value at call time (not at module load) so a user can switch
// workspace mid-session via setCurrentWorkspace and the next call uses
// the new value without a page reload.

const WORKSPACE_LS_KEY = "emploke.currentWorkspace";

export function getCurrentWorkspace(): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(WORKSPACE_LS_KEY) : null;
  } catch {
    return null;
  }
}

export function setCurrentWorkspace(name: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (name === null) window.localStorage.removeItem(WORKSPACE_LS_KEY);
    else window.localStorage.setItem(WORKSPACE_LS_KEY, name);
  } catch {
    // localStorage may be disabled (e.g. private mode); ignore — header
    // calls below will fall back to "no workspace selected".
  }
}

/**
 * Build the URL prefix for workspace-scoped resources. Throws if no
 * workspace is selected — the caller (Sessions page) should ensure a
 * workspace is selected before issuing any session call.
 */
function workspacePrefix(): string {
  const name = getCurrentWorkspace();
  if (!name) {
    throw new Error("no workspace selected");
  }
  return `/api/workspaces/${encodeURIComponent(name)}`;
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

// ─── Sessions (workspace-scoped) ──────────────────────────────────

export interface SessionRecord {
  id: string;
  workdir: string;
  agent: string;
  /** Runtime kind (e.g. "copilot"). */
  runtime: string;
  /** Native session ID assigned by the runtime, or null if not yet known. */
  runtimeSessionId: string | null;
  /** ISO 8601 string. */
  createdAt: string;
  /** ISO 8601 string of the runtime's last observed activity, or null. */
  lastActiveAt: string | null;
  /** Short human-readable preview from the runtime, or null. */
  preview: string | null;
}

export interface LaunchCommand {
  cmd: string;
  args: string[];
  cwd: string;
  display: string;
}

export interface ListSessionsOpts {
  agent?: string;
  /** ISO 8601 timestamp; sessions created before this are excluded server-side. */
  createdSince?: string;
}

export const listSessions = (opts: ListSessionsOpts = {}): Promise<SessionRecord[]> => {
  const params = new URLSearchParams();
  if (opts.agent) params.set("agent", opts.agent);
  if (opts.createdSince) params.set("createdSince", opts.createdSince);
  const qs = params.toString();
  return fetchJson<SessionRecord[]>(
    `${workspacePrefix()}/sessions${qs ? `?${qs}` : ""}`,
    "sessions",
  );
};

export const listRuntimes = (): Promise<string[]> =>
  fetchJson<string[]>("/api/runtimes", "runtimes");

export interface ServerConfig {
  emplokeHome: string;
  catalogDir: string;
  /** Currently-selected workspace name on the server registry, or null. */
  currentWorkspace: string | null;
  host: string;
  port: number;
  /** Native path separator on the server's OS. */
  pathSeparator: string;
}

export const getConfig = (): Promise<ServerConfig> =>
  fetchJson<ServerConfig>("/api/config", "config");

export const getSession = (id: string): Promise<SessionRecord> =>
  fetchJson<SessionRecord>(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}`, "session");

export const createSession = async (agent: string, runtime?: string): Promise<SessionRecord> => {
  const body: Record<string, string> = { agent };
  if (runtime !== undefined) body.runtime = runtime;
  const r = await fetch(`${workspacePrefix()}/sessions`, jsonInit("POST", body));
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = await r.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      // body not JSON; keep status
    }
    throw new Error(msg);
  }
  return (await r.json()) as SessionRecord;
};

export const deleteSession = (id: string, deleteRuntimeState = false) => {
  const qs = deleteRuntimeState ? "?deleteRuntimeState=1" : "";
  return mutate(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}${qs}`, {
    method: "DELETE",
  });
};

export interface SpawnSuccess {
  ok: true;
  launcher: string;
  display: string;
}

export interface SpawnFailure {
  ok: false;
  error: string;
  code?: string;
  display: string;
}

export type SpawnResult = SpawnSuccess | SpawnFailure;

export const spawnSession = async (id: string): Promise<SpawnResult> => {
  const r = await fetch(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}/spawn`, {
    method: "POST",
  });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = await r.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      // not json
    }
    throw new Error(msg);
  }
  return (await r.json()) as SpawnResult;
};

// ─── Workspaces ───────────────────────────────────────────────────

export interface WorkspaceMetadata {
  schemaVersion: number;
  name: string;
  createdAt: string;
  defaults?: {
    runtime?: string;
    agent?: string;
  };
}

export interface WorkspaceListItem {
  name: string;
  path: string;
  lastOpenedAt?: string;
  status: "ok" | "missing" | "corrupted";
  metadata?: WorkspaceMetadata;
  reason?: string;
}

export const listWorkspaces = (): Promise<WorkspaceListItem[]> =>
  fetchJson<WorkspaceListItem[]>("/api/workspaces", "workspaces");

export const getServerCurrentWorkspace = (): Promise<{ name: string | null }> =>
  fetchJson<{ name: string | null }>("/api/workspaces/current", "current-workspace");

export const setServerCurrentWorkspace = (name: string): Promise<void> =>
  mutate("/api/workspaces/current", jsonInit("PUT", { name }));

export const addWorkspace = async (
  pathInput: string,
  opts?: { name?: string; defaults?: WorkspaceMetadata["defaults"] },
): Promise<{ name: string; path: string }> => {
  const body: Record<string, unknown> = { path: pathInput };
  if (opts?.name !== undefined) body.name = opts.name;
  if (opts?.defaults !== undefined) body.defaults = opts.defaults;
  const r = await fetch("/api/workspaces", jsonInit("POST", body));
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = await r.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      // not json
    }
    throw new Error(msg);
  }
  return (await r.json()) as { name: string; path: string };
};

export const removeWorkspace = (name: string) =>
  mutate(`/api/workspaces/${encodeURIComponent(name)}`, { method: "DELETE" });

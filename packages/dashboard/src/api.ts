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

//  Workspace identity
//
// All workspace-scoped requests are routed through `/api/workspaces/<id>/...`
// where <id> is the UUID of the active workspace. The active workspace is
// owned by the React Router URL (`/workspaces/:wsId/...`), not localStorage
//  so opening two browser tabs at different workspaces no longer makes
// them fight over a shared global. The route layout calls
// `setActiveWorkspace` on every URL change to keep this module-level slot
// in sync; api helpers below pull from it at call time so callers don't
// have to thread a workspace argument through every signature.

let activeWorkspace: string | null = null;

/** Called by the route layout whenever the URL's wsId segment changes. */
export function setActiveWorkspace(id: string | null): void {
  activeWorkspace = id;
}

/** Read the workspace currently in scope for the active route. */
export function getActiveWorkspace(): string | null {
  return activeWorkspace;
}

/**
 * Build the URL prefix for workspace-scoped resources. Throws if no
 * workspace is in scope  call sites should ensure the user is on a
 * `/workspaces/:wsId/...` route before issuing per-workspace requests.
 */
function workspacePrefix(): string {
  if (!activeWorkspace) {
    throw new Error("no workspace selected");
  }
  return `/api/workspaces/${encodeURIComponent(activeWorkspace)}`;
}

/** URL prefix for the active workspace's catalog endpoints. */
function catalogPrefix(): string {
  return `${workspacePrefix()}/catalog`;
}

const fetchJson = async <T>(path: string, label: string): Promise<T> => {
  const r = await fetch(path);
  if (!r.ok) {
    throw new Error(`${label}: ${r.status}`);
  }
  return r.json() as Promise<T>;
};

export async function fetchAll(): Promise<CatalogData> {
  const base = catalogPrefix();
  const [overview, skills, agents, mcps] = await Promise.all([
    fetchJson<OverviewData>(`${base}/overview`, "overview"),
    fetchJson<SkillEntry[]>(`${base}/skills`, "skills"),
    fetchJson<AgentEntry[]>(`${base}/agents`, "agents"),
    fetchJson<McpItem[]>(`${base}/mcps`, "mcps"),
  ]);
  return { overview, skills, agents, mcps };
}

//  Mutations

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
  mutate(`${catalogPrefix()}/agents`, jsonInit("POST", { sourcePath }));

export const installSkill = (sourcePath: string) =>
  mutate(`${catalogPrefix()}/skills`, jsonInit("POST", { sourcePath }));

export const installMcp = (sourcePath: string, name?: string) =>
  mutate(`${catalogPrefix()}/mcps`, jsonInit("POST", name ? { sourcePath, name } : { sourcePath }));

export const removeAgent = (name: string) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, { method: "DELETE" });

export const removeSkill = (name: string) =>
  mutate(`${catalogPrefix()}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });

export const removeMcp = (name: string) =>
  mutate(`${catalogPrefix()}/mcps/${encodeURIComponent(name)}`, { method: "DELETE" });

export interface McpDetail {
  name: string;
  path: string | null;
  /** Raw JSON content as stored on disk (preserves user formatting). */
  content: string;
}

export const getMcp = (name: string): Promise<McpDetail> =>
  fetchJson<McpDetail>(`${catalogPrefix()}/mcps/${encodeURIComponent(name)}`, "mcp");

export const updateMcpContent = (name: string, content: string) =>
  mutate(`${catalogPrefix()}/mcps/${encodeURIComponent(name)}`, jsonInit("PUT", { content }));

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
  fetchJson<SkillDetail>(`${catalogPrefix()}/skills/${encodeURIComponent(name)}`, "skill");

export const getSkillContent = (name: string): Promise<string> =>
  getSkill(name).then((d) => d.content);

export const updateSkillContent = (name: string, content: string) =>
  mutate(`${catalogPrefix()}/skills/${encodeURIComponent(name)}`, jsonInit("PUT", { content }));

export interface SkillMetadataPatch {
  description?: string;
  version?: string;
  prereqs?: string | null;
  dependencies?: { skills?: string[]; mcps?: string[] } | null;
}

export const patchSkillMetadata = (name: string, patch: SkillMetadataPatch) =>
  mutate(`${catalogPrefix()}/skills/${encodeURIComponent(name)}`, jsonInit("PATCH", patch));

export interface AgentDetail {
  agent: import("@emploke/catalog").Agent;
  status: "ready" | "disabled";
  missingDeps?: MissingDep[];
  content: string;
}

export const getAgent = (name: string): Promise<AgentDetail> =>
  fetchJson<AgentDetail>(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, "agent");

export const getAgentContent = (name: string): Promise<string> =>
  getAgent(name).then((d) => d.content);

export const updateAgentContent = (name: string, content: string) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, jsonInit("PUT", { content }));

export interface AgentMetadataPatch {
  description?: string;
  version?: string;
  dependencies?: { skills?: string[]; mcps?: string[] } | null;
}

export const patchAgentMetadata = (name: string, patch: AgentMetadataPatch) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, jsonInit("PATCH", patch));

//  Sessions (workspace-scoped)

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
  /** Currently-selected workspace id (UUID) on the server registry, or null. */
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

//  Workspaces ─

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
  /** Opaque UUID; the URL routing key. */
  id: string;
  path: string;
  lastOpenedAt?: string;
  status: "ok" | "missing" | "corrupted";
  metadata?: WorkspaceMetadata;
  reason?: string;
}

export const listWorkspaces = (): Promise<WorkspaceListItem[]> =>
  fetchJson<WorkspaceListItem[]>("/api/workspaces", "workspaces");

export const getServerCurrentWorkspace = (): Promise<{ id: string | null }> =>
  fetchJson<{ id: string | null }>("/api/workspaces/current", "current-workspace");

export const setServerCurrentWorkspace = (id: string): Promise<void> =>
  mutate("/api/workspaces/current", jsonInit("PUT", { id }));

/**
 * Created workspace as returned by `POST /api/workspaces`. Mirrors the
 * server's response shape so we can render the new entry without a full
 * list refresh.
 */
export interface CreatedWorkspace {
  id: string;
  path: string;
  lastOpenedAt?: string;
  metadata: WorkspaceMetadata;
}

export const addWorkspace = async (
  pathInput: string,
  opts: { name: string; defaults?: WorkspaceMetadata["defaults"] },
): Promise<CreatedWorkspace> => {
  const body: Record<string, unknown> = { path: pathInput, name: opts.name };
  if (opts.defaults !== undefined) body.defaults = opts.defaults;
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
  return (await r.json()) as CreatedWorkspace;
};

export const removeWorkspace = (id: string) =>
  mutate(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });

export const updateWorkspaceMetadata = async (
  id: string,
  patch: { name?: string; defaults?: WorkspaceMetadata["defaults"] | null },
): Promise<WorkspaceListItem> => {
  const r = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, jsonInit("PATCH", patch));
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
  return (await r.json()) as WorkspaceListItem;
};

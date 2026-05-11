import type { AgentEntry, McpMetadata, MissingDep, SkillEntry } from "@emploke/catalog";

export interface OverviewData {
  counts: {
    skills: number;
    agents: number;
    mcps: number;
    disabled: number;
  };
}

/**
 * Wire shape for an installed MCP — mirrors @emploke/catalog `McpMetadata`.
 * `mutable` controls whether the dashboard offers Edit (file: origin) vs
 * Sync (re-install from upstream for github: etc.).
 */
export type McpItem = McpMetadata;

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

/**
 * Best-effort extraction of a server-provided error message from a
 * non-OK fetch response. Falls back to the bare HTTP status if the body
 * isn't JSON or doesn't carry an `error` field. Used by both `mutate`
 * (which discards the body) and `mutateJson` (which returns the parsed
 * success body).
 */
async function extractError(r: Response): Promise<string> {
  let msg = `${r.status}`;
  try {
    const body = await r.json();
    if (body && typeof body.error === "string") msg = body.error;
  } catch {
    // body not JSON; keep status
  }
  return msg;
}

const mutate = async (path: string, init: RequestInit): Promise<void> => {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(await extractError(r));
};

const mutateJson = async <T>(path: string, init: RequestInit): Promise<T> => {
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(await extractError(r));
  return (await r.json()) as T;
};

const jsonInit = (method: string, body: object): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Install a new agent. The wire body is `{provider, location}` — the
 * server assembles the canonical origin URI from those. The server
 * fetches via the registered fetcher (file:, https://github.com/...),
 * recursively resolves dependencies, and returns a manifest. Returns
 * 207 on partial failure — caller surfaces that as an error message
 * via {@link extractError}.
 *
 * No `scopeHints`: scope is determined entirely by each entry's
 * frontmatter (or default `public`). Forking under a different scope =
 * editing upstream's frontmatter, not a per-install flag.
 */
export type InstallProvider = "github" | "file";

export interface InstallSource {
  /** Pick the provider whose grammar matches your URL/path. */
  provider: InstallProvider;
  /**
   * Canonical input string for the chosen provider:
   *  - `github`: full https://github.com/owner/repo/tree/ref/path URL
   *  - `file`:   absolute filesystem path on the server
   * Whitespace is trimmed; clients never need to add scheme prefixes.
   */
  location: string;
}

export const installAgent = (src: InstallSource) =>
  mutate(`${catalogPrefix()}/agents`, jsonInit("POST", src));

/** See {@link installAgent}. */
export const installSkill = (src: InstallSource) =>
  mutate(`${catalogPrefix()}/skills`, jsonInit("POST", src));

/**
 * Install an MCP. The MCP's spec FQN is recovered from the fetched
 * JSON's `_meta.name` at install time, so callers don't need to
 * supply a name.
 */
export const installMcp = (src: InstallSource) =>
  mutate(`${catalogPrefix()}/mcps`, jsonInit("POST", src));

/**
 * Resolve manifest returned by `POST /catalog/{kind}/resolve`. Read-only
 * preview of the dep graph the install will create. Used by the
 * dashboard's two-phase install dialog so the user can preview the
 * tree (status / scope / conflicts) before committing.
 */
export interface ResolveNodeBase {
  kind: "skill" | "agent" | "mcp";
  origin: string;
  fqn: string;
  status:
    | "new"
    | "will-sync"
    | "already-installed"
    | "would-conflict"
    | "fetch-failed"
    | "parse-failed";
  depFqns: string[];
  error?: { name: string; message: string };
}

export interface SkillResolveNode extends ResolveNodeBase {
  kind: "skill";
  shortName: string;
  /** Scope as it'll appear in the catalog (frontmatter or `public` default). */
  scope: string;
  /** True iff the entry's frontmatter omitted `scope:` and we used the default. */
  scopeIsDefault: boolean;
}

export interface AgentResolveNode extends ResolveNodeBase {
  kind: "agent";
  shortName: string;
  scope: string;
  scopeIsDefault: boolean;
}

export interface McpResolveNode extends ResolveNodeBase {
  kind: "mcp";
  specName: string;
}

export type ResolveNode = SkillResolveNode | AgentResolveNode | McpResolveNode;

export interface ResolveManifest {
  rootFqn: string;
  nodes: ResolveNode[];
}

/**
 * Resolve an install (`POST /catalog/{kind}/resolve`) — returns the
 * read-only `ResolveManifest` so the user can preview the tree before
 * committing.
 */
export const resolveSkillInstall = (src: InstallSource): Promise<ResolveManifest> =>
  mutateJson<ResolveManifest>(`${catalogPrefix()}/skills/resolve`, jsonInit("POST", src));

export const resolveAgentInstall = (src: InstallSource): Promise<ResolveManifest> =>
  mutateJson<ResolveManifest>(`${catalogPrefix()}/agents/resolve`, jsonInit("POST", src));

export const removeAgent = (name: string) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, { method: "DELETE" });

export const removeSkill = (name: string) =>
  mutate(`${catalogPrefix()}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });

export const removeMcp = (name: string) =>
  mutate(`${catalogPrefix()}/mcps/${encodeURIComponent(name)}`, { method: "DELETE" });

export interface McpDetail {
  name: string;
  origin: string;
  mutable: boolean;
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
  skill: import("@emploke/catalog").SkillPojo;
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
  dependencies?: {
    skills?: import("@emploke/catalog").DependencyRef[];
    mcps?: import("@emploke/catalog").DependencyRef[];
  } | null;
}

export const patchSkillMetadata = (name: string, patch: SkillMetadataPatch) =>
  mutate(`${catalogPrefix()}/skills/${encodeURIComponent(name)}`, jsonInit("PATCH", patch));

export interface AgentDetail {
  agent: import("@emploke/catalog").AgentPojo;
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
  dependencies?: {
    skills?: import("@emploke/catalog").DependencyRef[];
    mcps?: import("@emploke/catalog").DependencyRef[];
  } | null;
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
  /**
   * ISO 8601 timestamp; sessions whose lastActiveAt is before this (or
   * null) are excluded server-side. More expensive than createdSince
   * because the server must call runtime.refresh() before filtering.
   */
  activeSince?: string;
}

export const listSessions = (opts: ListSessionsOpts = {}): Promise<SessionRecord[]> => {
  const params = new URLSearchParams();
  if (opts.agent) params.set("agent", opts.agent);
  if (opts.createdSince) params.set("createdSince", opts.createdSince);
  if (opts.activeSince) params.set("activeSince", opts.activeSince);
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
  /** Tunables for the dashboard's task list view. */
  tasks: {
    /**
     * Poll cadence for the running task list (ms). Owned by the server so
     * the dashboard never hard-codes a UX-shaping constant.
     */
    pollIntervalMs: number;
  };
}

export const getConfig = (): Promise<ServerConfig> =>
  fetchJson<ServerConfig>("/api/config", "config");

/**
 * Mirrors the server's `HealthResponse` (defined in
 * `@emploke/server/routes/health.ts`). Re-declared here rather than
 * imported because `@emploke/server` is a Node package and the dashboard
 * bundle should not depend on it.
 */
export interface HealthResponse {
  status: "ok";
  name: string;
  version: string;
  startedAt: string;
  uptimeSec: number;
  /** ISO 8601 UTC timestamp at the moment the server formed the response. */
  serverNow: string;
}

export const getHealth = (): Promise<HealthResponse> =>
  fetchJson<HealthResponse>("/api/health", "health");

export const getSession = (id: string): Promise<SessionRecord> =>
  fetchJson<SessionRecord>(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}`, "session");

export const createSession = async (agent: string, runtime?: string): Promise<SessionRecord> => {
  const body: Record<string, string> = { agent };
  if (runtime !== undefined) body.runtime = runtime;
  return mutateJson<SessionRecord>(`${workspacePrefix()}/sessions`, jsonInit("POST", body));
};

export const deleteSession = (id: string, deleteRuntimeState = false) => {
  // Sessions are sandbox dirs (only emploke-managed contents) — the
  // dashboard "delete" action removes both metadata and workdir.
  // `?purge=1` enables the workdir removal; the manager defaults to
  // metadata-only so the API matches workspace/task semantics. A
  // future "archive" mode (preserve workdir) would expose this as a
  // checkbox in the confirm modal.
  const params: string[] = ["purge=1"];
  if (deleteRuntimeState) params.push("deleteRuntimeState=1");
  return mutate(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}?${params.join("&")}`, {
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

export const spawnSession = async (id: string): Promise<SpawnResult> =>
  mutateJson<SpawnResult>(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}/spawn`, {
    method: "POST",
  });

//  Workspaces ─

/**
 * A registered workspace, as returned by the `/api/workspaces` family of
 * endpoints. The shape mirrors the server's `Workspace` domain type — flat,
 * no `metadata` wrapper, no `schemaVersion` (that's a Repository-internal
 * concern). `workdir` is the only filesystem path field; everything else is
 * pure metadata that survives a backend swap (FS today, SQLite tomorrow).
 */
export interface WorkspaceListItem {
  /** Opaque UUID; the URL routing key. */
  id: string;
  /** Display name (free-form text, 1-64 trimmed chars). */
  name: string;
  /** ISO 8601 UTC timestamp at creation. */
  createdAt: string;
  /** Absolute filesystem path the agents work under. */
  workdir: string;
  /** Optional UX defaults for sessions/tasks dispatched in this workspace. */
  defaults?: {
    runtime?: string;
    agent?: string;
  };
}

export const listWorkspaces = (): Promise<WorkspaceListItem[]> =>
  fetchJson<WorkspaceListItem[]>("/api/workspaces", "workspaces");

export const getServerCurrentWorkspace = (): Promise<{ id: string | null }> =>
  fetchJson<{ id: string | null }>("/api/workspaces/current", "current-workspace");

export const setServerCurrentWorkspace = (id: string): Promise<void> =>
  mutate("/api/workspaces/current", jsonInit("PUT", { id }));

/**
 * Created workspace as returned by `POST /api/workspaces`. Identical shape
 * to {@link WorkspaceListItem} — kept as a separate type only for callsite
 * clarity (the server returns 201 + the same body).
 */
export type CreatedWorkspace = WorkspaceListItem;

export const addWorkspace = async (opts: {
  name: string;
  /** Optional. When omitted, the server creates a fresh
   *  `<EMPLOKE_HOME>/workspaces/<uuid>/` directory. */
  workdir?: string;
  defaults?: WorkspaceListItem["defaults"];
}): Promise<CreatedWorkspace> => {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.workdir !== undefined && opts.workdir !== "") body.workdir = opts.workdir;
  if (opts.defaults !== undefined) body.defaults = opts.defaults;
  return mutateJson<CreatedWorkspace>("/api/workspaces", jsonInit("POST", body));
};

/**
 * Remove a workspace from the registry.
 *
 * Default behaviour: metadata-only — `workspace.json` and the index entry
 * are deleted but the user's directory contents (their files, plus any
 * agent-produced sessions/, tasks/, catalog/) stay on disk untouched.
 *
 * Pass `{ purge: true }` to also rm every emploke-owned subdirectory under
 * the workspace's workdir. The workdir itself is never removed — that's
 * user-owned and outside the manager's purview.
 */
export const removeWorkspace = (id: string, opts?: { purge?: boolean }) => {
  const qs = opts?.purge ? "?purge=1" : "";
  return mutate(`/api/workspaces/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
};

export const updateWorkspaceMetadata = async (
  id: string,
  patch: { name?: string; defaults?: WorkspaceListItem["defaults"] | null },
): Promise<WorkspaceListItem> =>
  mutateJson<WorkspaceListItem>(
    `/api/workspaces/${encodeURIComponent(id)}`,
    jsonInit("PATCH", patch),
  );

// ─ Tasks (workspace-scoped) ─
//
// A Task is an autonomous one-shot agent invocation: dispatch a brief +
// instructions, the runtime spawns the agent, and the dashboard polls for
// terminal status. Each runtime publishes its own native event log; the
// server resolves the path via the runtime's `taskEventsPath` surface and
// streams the bytes opaquely. Filename, format, and on-disk layout are
// runtime-specific (today the Copilot adapter writes NDJSON; future
// runtimes may differ).

export type TaskStatus = "not_started" | "running" | "success" | "failure" | "cancelled";

/**
 * Task failure shape — matches the kernel's `TaskFailure` exactly. The
 * field is `error` (not `reason`) and there are no nested exit fields:
 * exit code/signal live in `metadata.exitCode` / `metadata.exitSignal`
 * because they're runtime-specific bookkeeping, not part of the abstract
 * Task value model.
 */
export interface TaskFailure {
  error: string;
}

export interface TaskResult {
  output: string;
}

export interface TaskRecord {
  id: string;
  agent: string;
  instructions: string;
  status: TaskStatus;
  /**
   * Open-shape metadata. Includes runtime bookkeeping fields like
   * `workdir`, `runtime`, `runtimeSessionId`, `pid`, `exitCode`,
   * `exitSignal` — the runtime owns the keys, the kernel doesn't inspect.
   */
  metadata: Record<string, unknown>;
  /** ISO 8601 string. */
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  result?: TaskResult;
  failure?: TaskFailure;
}

/**
 * Optional server-side filters for `listTasks`. Mirrors the server's
 * `ListTaskOpts` (which mirrors `ListSessionOpts` in the sessions
 * surface). Omitted fields are not sent on the wire and the server
 * returns the full set.
 */
export interface ListTasksOpts {
  agent?: string;
  runtime?: string;
  /** ISO 8601 (the server canonicalises). */
  createdSince?: string;
  /** Statuses to include. The server joins with `,` for the query. */
  statuses?: TaskStatus[];
}

export const listTasks = (opts: ListTasksOpts = {}): Promise<TaskRecord[]> => {
  const qs = new URLSearchParams();
  if (opts.agent) qs.set("agent", opts.agent);
  if (opts.runtime) qs.set("runtime", opts.runtime);
  if (opts.createdSince) qs.set("createdSince", opts.createdSince);
  if (opts.statuses && opts.statuses.length > 0) qs.set("status", opts.statuses.join(","));
  const suffix = qs.toString() === "" ? "" : `?${qs.toString()}`;
  return fetchJson<TaskRecord[]>(`${workspacePrefix()}/tasks${suffix}`, "tasks");
};

export const getTask = (id: string): Promise<TaskRecord> =>
  fetchJson<TaskRecord>(`${workspacePrefix()}/tasks/${encodeURIComponent(id)}`, "task");

export const dispatchTask = async (
  agent: string,
  instructions: string,
  runtime?: string,
): Promise<TaskRecord> => {
  const body: Record<string, string> = { agent, instructions };
  if (runtime !== undefined) body.runtime = runtime;
  return mutateJson<TaskRecord>(`${workspacePrefix()}/tasks`, jsonInit("POST", body));
};

export const deleteTask = (id: string) =>
  // Tasks are sandbox dirs — `?purge=1` ensures both metadata and
  // workdir are removed so the dashboard "delete" UI behaves as the
  // user expects (no leftover files). A future "archive" mode would
  // toggle this off.
  mutate(`${workspacePrefix()}/tasks/${encodeURIComponent(id)}?purge=1`, { method: "DELETE" });

/**
 * Build the URL to the task event stream. The server resolves the
 * underlying file via `Runtime.taskEventsPath` and returns its bytes as
 * `application/x-ndjson` (today, since the only runtime is Copilot's
 * NDJSON; future runtimes may serve other formats and the dashboard
 * will need to branch on `task.metadata.runtime` to render them). We
 * fetch the whole file with `fetch().text()` rather than EventSource
 * because the route is a one-shot read, not SSE; the polling loop on
 * the detail page handles "tail" semantics.
 */
export const taskEventsUrl = (id: string): string =>
  `${workspacePrefix()}/tasks/${encodeURIComponent(id)}/events`;

export const fetchTaskEvents = async (id: string): Promise<string | null> => {
  const r = await fetch(taskEventsUrl(id));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(await extractError(r));
  return r.text();
};

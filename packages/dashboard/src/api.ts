import type { AgentEntry, McpMetadata, MissingDep, SkillEntry } from "@emploke/catalog";

export interface OverviewData {
  counts: {
    skills: number;
    agents: number;
    mcps: number;
    blocked: number;
    orphaned: number;
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
 * Install a new agent. Wire body is `{ origin: string }` — the
 * canonical origin URI is the only identity downstream (catalog DB
 * row, AGENTS.md `dependencies:` blocks, fetcher dispatch). The
 * dashboard presents a friendlier `provider + location` form to
 * humans, then assembles the canonical origin URI client-side via
 * {@link buildOriginFromSource} before posting.
 *
 * Why client-side assembly: keeps the wire shape narrow + matches
 * what the CLI sends + matches what every YAML/markdown frontmatter
 * dependency declares. Earlier wire shapes carried `{ provider,
 * location }` on the wire; that forced the server to know two
 * representations and let the CLI / dashboard drift apart silently
 * (the CLI's manifest type said `{ origin }`, dashboard sent
 * `{ provider, location }`, server validator only accepted the
 * latter, CLI install was 100% broken). Single wire shape removes
 * the gap class entirely.
 *
 * The server then fetches via the registered fetcher (file:,
 * https://github.com/...), recursively resolves dependencies, and
 * returns a manifest. Returns 207 on partial failure — caller
 * surfaces that as an error message via {@link extractError}.
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

/**
 * Wire body for every catalog install / install-resolve route. The
 * `origin` field is the canonical URI the server's fetcher dispatches
 * on; it is identical to what `dependencies:` blocks reference inside
 * SKILL.md / AGENTS.md. CLI users type one of these directly; the
 * dashboard assembles it from its UI form via
 * {@link buildOriginFromSource}.
 */
export interface InstallBody {
  readonly origin: string;
}

/**
 * Assemble a canonical origin URI from the dashboard's UI form.
 *
 *   - `github` + `https://github.com/owner/repo/tree/ref/path` →
 *     pass-through (the URL is already the canonical github origin)
 *   - `file`   + `/abs/path`            → `file:/abs/path`
 *   - `file`   + `file:/abs/path`       → `file:/abs/path` (tolerate
 *     paste with prefix; trim and re-emit)
 *
 * Mirrors the assembly the CLI never had to do (CLI users always
 * type the canonical URI directly). Tests in `dashboard/test/`
 * (added in PR #96) pin the contract.
 */
export function buildOriginFromSource(src: InstallSource): string {
  const trimmed = src.location.trim();
  switch (src.provider) {
    case "github":
      return trimmed;
    case "file":
      return trimmed.startsWith("file:") ? trimmed : `file:${trimmed}`;
  }
}

/**
 * Wire mirror of `@emploke/catalog` ``CatalogInstalledEntry``. Each
 * row in `installed[]` carries enough info for the dashboard to
 * prompt the user about pending prereqs without a follow-up GET.
 */
export interface InstalledEntry {
  kind: "skill" | "agent" | "mcp";
  fqn: string;
  /** Frontmatter prereqs text. Absent for mcps and for entries with no prereqs. */
  prereqs?: string;
  /** Per-installation ack flag. Absent for mcps. False iff prereqs is set and pending ack. */
  prereqsAck?: boolean;
}

/** Wire mirror of `@emploke/catalog` ``CatalogInstallResult``. */
export interface InstallResult {
  installed: InstalledEntry[];
  skipped: { kind: "skill" | "agent" | "mcp"; fqn: string; reason: string }[];
  failed: {
    kind: "skill" | "agent" | "mcp";
    fqn: string;
    error: { name: string; message: string };
  }[];
}

/** Wire mirror of `@emploke/catalog` ``CatalogSyncResult``. */
export interface SyncResult extends InstallResult {
  orphansFlagged: { kind: "skill" | "mcp"; fqn: string; origin: string }[];
}

export const installAgent = (src: InstallSource): Promise<InstallResult> =>
  mutateJson<InstallResult>(
    `${catalogPrefix()}/agents`,
    jsonInit("POST", { origin: buildOriginFromSource(src) } satisfies InstallBody),
  );

/** See {@link installAgent}. */
export const installSkill = (src: InstallSource): Promise<InstallResult> =>
  mutateJson<InstallResult>(
    `${catalogPrefix()}/skills`,
    jsonInit("POST", { origin: buildOriginFromSource(src) } satisfies InstallBody),
  );

/**
 * Install an MCP. The MCP's spec FQN is recovered from the fetched
 * JSON's `_meta.name` at install time, so callers don't need to
 * supply a name.
 */
export const installMcp = (src: InstallSource): Promise<InstallResult> =>
  mutateJson<InstallResult>(
    `${catalogPrefix()}/mcps`,
    jsonInit("POST", { origin: buildOriginFromSource(src) } satisfies InstallBody),
  );

/**
 * Resolve manifest returned by `POST /catalog/{kind}/resolve` (install)
 * and `POST /catalog/{kind}/:fqn/sync/resolve` (sync). Read-only
 * preview of the dep graph the operation will create. Used by the
 * dashboard's two-phase install/sync dialog.
 *
 * Sync-only fields (`isSync`, `upToDate`, `identityChange`, `orphans`)
 * are populated by the sync resolve endpoint; install resolve leaves
 * them at their no-op defaults.
 */
export interface ResolveNodeBase {
  kind: "skill" | "agent" | "mcp";
  origin: string;
  fqn: string;
  status:
    | "new"
    | "will-sync"
    | "already-installed"
    | "up-to-date"
    | "identity-changed"
    | "would-conflict"
    | "fetch-failed"
    | "parse-failed";
  depFqns: string[];
  identityChange?: { oldFqn: string; newFqn: string };
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

export interface OrphanManifestEntry {
  kind: "skill" | "mcp";
  fqn: string;
  origin: string;
}

export interface ResolveManifest {
  rootOrigin: string;
  rootFqn: string;
  isSync: boolean;
  /**
   * Single-use token returned only by sync resolves. The dashboard
   * stores it across the preview-then-apply UX and ships it back on
   * `apply*Sync(fqn, planToken)`; the server replays the exact
   * preview-time plan rather than re-resolving (which would silently
   * apply a fresh, possibly-different closure).
   *
   * Server TTL is currently 5 min. If the user lets the preview sit
   * too long, apply returns 410 and the dashboard should re-preview.
   *
   * Absent on install resolves — install is naturally idempotent
   * since the user re-supplies the same origin.
   */
  planToken?: string;
  upToDate: boolean;
  identityChange?: { kind: "skill" | "agent" | "mcp"; oldFqn: string; newFqn: string };
  orphans: OrphanManifestEntry[];
  nodes: ResolveNode[];
}

/**
 * Resolve an install (`POST /catalog/{kind}/resolve`) — returns the
 * read-only `ResolveManifest` so the user can preview the tree before
 * committing.
 */
export const resolveSkillInstall = (src: InstallSource): Promise<ResolveManifest> =>
  mutateJson<ResolveManifest>(
    `${catalogPrefix()}/skills/resolve`,
    jsonInit("POST", { origin: buildOriginFromSource(src) } satisfies InstallBody),
  );

export const resolveAgentInstall = (src: InstallSource): Promise<ResolveManifest> =>
  mutateJson<ResolveManifest>(
    `${catalogPrefix()}/agents/resolve`,
    jsonInit("POST", { origin: buildOriginFromSource(src) } satisfies InstallBody),
  );

/**
 * Resolve a sync from upstream for an already-installed entry. The
 * server reads the entry's local origin from the row; the dashboard
 * passes only the local fqn / mcp name in the URL.
 *
 * Sync resolve emits a richer manifest than install resolve:
 *  - `upToDate` short-circuits the apply button when nothing changed
 *  - `identityChange` warns when upstream renamed under the same URL
 *  - `orphans` lists deps that the new closure dropped
 */
export const resolveSkillSync = (fqn: string): Promise<ResolveManifest> =>
  mutateJson<ResolveManifest>(`${catalogPrefix()}/skills/${encodeURIComponent(fqn)}/sync/resolve`, {
    method: "POST",
  });

export const resolveAgentSync = (fqn: string): Promise<ResolveManifest> =>
  mutateJson<ResolveManifest>(`${catalogPrefix()}/agents/${encodeURIComponent(fqn)}/sync/resolve`, {
    method: "POST",
  });

export const resolveMcpSync = (name: string): Promise<ResolveManifest> =>
  mutateJson<ResolveManifest>(`${catalogPrefix()}/mcps/${encodeURIComponent(name)}/sync/resolve`, {
    method: "POST",
  });

/**
 * Apply a previously-previewed sync. The `planToken` MUST come from
 * the matching `resolve*Sync` response — the server replays that
 * exact plan instead of re-resolving (otherwise upstream drift
 * between preview and apply would silently change what gets
 * installed). Token is single-use; a 410 means it expired (default
 * 5 min) or was already consumed, and the dashboard should
 * re-preview.
 */
export const applySkillSync = (fqn: string, planToken: string): Promise<SyncResult> =>
  mutateJson<SyncResult>(
    `${catalogPrefix()}/skills/${encodeURIComponent(fqn)}/sync`,
    jsonInit("POST", { planToken }),
  );

export const applyAgentSync = (fqn: string, planToken: string): Promise<SyncResult> =>
  mutateJson<SyncResult>(
    `${catalogPrefix()}/agents/${encodeURIComponent(fqn)}/sync`,
    jsonInit("POST", { planToken }),
  );

export const applyMcpSync = (name: string, planToken: string): Promise<SyncResult> =>
  mutateJson<SyncResult>(
    `${catalogPrefix()}/mcps/${encodeURIComponent(name)}/sync`,
    jsonInit("POST", { planToken }),
  );

/** Acknowledge prereqs: flips `prereqsAck=true` so the entry can run again. */
export const acknowledgeSkillPrereqs = (fqn: string) =>
  mutate(`${catalogPrefix()}/skills/${encodeURIComponent(fqn)}/acknowledge-prereqs`, {
    method: "POST",
  });

export const acknowledgeAgentPrereqs = (fqn: string) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(fqn)}/acknowledge-prereqs`, {
    method: "POST",
  });

/** Disable / enable an agent (user-controlled toggle; agents only). */
export const disableAgent = (fqn: string) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(fqn)}/disable`, { method: "POST" });

export const enableAgent = (fqn: string) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(fqn)}/enable`, { method: "POST" });

export const deleteAgent = (name: string) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, { method: "DELETE" });

export const deleteSkill = (name: string) =>
  mutate(`${catalogPrefix()}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });

export const deleteMcp = (name: string) =>
  mutate(`${catalogPrefix()}/mcps/${encodeURIComponent(name)}`, { method: "DELETE" });

export interface McpDetail {
  name: string;
  origin: string;
  mutable: boolean;
  orphaned: boolean;
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
  status: "ready" | "blocked";
  blockedReason?: import("@emploke/catalog").BlockedReason;
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
    /** Origin URI strings — wire frontmatter shape (catalog v2 out-of-scope). */
    skills?: string[];
    mcps?: string[];
  } | null;
}

export const patchSkillMetadata = (name: string, patch: SkillMetadataPatch) =>
  mutate(`${catalogPrefix()}/skills/${encodeURIComponent(name)}`, jsonInit("PATCH", patch));

export interface AgentDetail {
  agent: import("@emploke/catalog").AgentPojo;
  status: "ready" | "blocked";
  blockedReason?: import("@emploke/catalog").BlockedReason;
  missingDeps?: MissingDep[];
  content: string;
}

export const getAgent = (name: string): Promise<AgentDetail> =>
  fetchJson<AgentDetail>(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, "agent");

export const getAgentContent = (name: string): Promise<string> =>
  getAgent(name).then((d) => d.content);

export const updateAgentContent = (name: string, content: string) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, jsonInit("PUT", { content }));

/** PATCH body for updating agent metadata; mirrors @emploke/catalog `AgentMetadataPatch`. */
export interface AgentMetadataPatch {
  description?: string;
  version?: string;
  prereqs?: string | null;
  dependencies?: {
    skills?: string[];
    mcps?: string[];
  } | null;
}

export const patchAgentMetadata = (name: string, patch: AgentMetadataPatch) =>
  mutate(`${catalogPrefix()}/agents/${encodeURIComponent(name)}`, jsonInit("PATCH", patch));

//  Sessions (workspace-scoped)

export interface SessionView {
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
  /**
   * Mode the user chose for the most recent successful launch of this
   * session, or null if it has never been launched. Drives the default
   * action of the Resume split button.
   */
  lastLaunchMode: "local" | "remote" | null;
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

export const listSessions = (opts: ListSessionsOpts = {}): Promise<SessionView[]> => {
  const params = new URLSearchParams();
  if (opts.agent) params.set("agent", opts.agent);
  if (opts.createdSince) params.set("createdSince", opts.createdSince);
  if (opts.activeSince) params.set("activeSince", opts.activeSince);
  const qs = params.toString();
  return fetchJson<SessionView[]>(`${workspacePrefix()}/sessions${qs ? `?${qs}` : ""}`, "sessions");
};

/**
 * Wire shape returned by `GET /api/runtimes`. Mirrors the server's
 * `RuntimeInfo`. `capabilities` is a free-form bag — known keys today
 * are `remoteSession?: boolean` (Copilot) but the dashboard treats it
 * as plain `Record<string, unknown>` so server-side additions don't
 * require a dashboard rebuild.
 */
export interface RuntimeInfo {
  kind: string;
  capabilities: Record<string, unknown>;
}

export const listRuntimes = (): Promise<RuntimeInfo[]> =>
  fetchJson<RuntimeInfo[]>("/api/runtimes", "runtimes");

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

export const getSession = (id: string): Promise<SessionView> =>
  fetchJson<SessionView>(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}`, "session");

export const createSession = async (agent: string, runtime?: string): Promise<SessionView> => {
  const body: Record<string, string> = { agent };
  if (runtime !== undefined) body.runtime = runtime;
  return mutateJson<SessionView>(`${workspacePrefix()}/sessions`, jsonInit("POST", body));
};

export const deleteSession = (id: string, opts?: { purge?: boolean }) => {
  // Default ("archive") removes only the session metadata row — workdir
  // contents (AGENTS.md + agent-produced files) and the runtime
  // adapter's per-session state both stay on disk so the user can
  // recover or inspect them later. `{ purge: true }` is the hard-delete
  // path: row + workdir + runtime state, all gone. The confirm modal
  // exposes this as a single checkbox.
  const qs = opts?.purge ? "?purge=1" : "";
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

export const spawnSession = async (
  id: string,
  opts: { remote?: boolean } = {},
): Promise<SpawnResult> =>
  mutateJson<SpawnResult>(`${workspacePrefix()}/sessions/${encodeURIComponent(id)}/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(opts.remote === true ? { remote: true } : {}) }),
  });

//  Workspaces ─

/**
 * A registered workspace, as returned by the `/api/workspaces` family of
 * endpoints. The shape mirrors the server's `Workspace` domain type — flat,
 * no `metadata` wrapper, no `schemaVersion` (that's a Repository-internal
 * concern). `workspaceDir` is the only filesystem path field; everything
 * else is pure metadata that survives a backend swap (FS today, SQLite
 * tomorrow).
 */
export interface WorkspaceListItem {
  /** Opaque UUID; the URL routing key. */
  id: string;
  /** Display name (free-form text, 1-64 trimmed chars). */
  name: string;
  /** ISO 8601 UTC timestamp at creation. */
  createdAt: string;
  /** Absolute filesystem path the workspace lives under. */
  workspaceDir: string;
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
  workspaceDir?: string;
}): Promise<CreatedWorkspace> => {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.workspaceDir !== undefined && opts.workspaceDir !== "")
    body.workspaceDir = opts.workspaceDir;
  return mutateJson<CreatedWorkspace>("/api/workspaces", jsonInit("POST", body));
};

/**
 * Remove a workspace from the registry.
 *
 * Default behaviour: metadata-only — the registry row in `global.db`
 * is deleted but the user's directory contents (their files, plus any
 * agent-produced sessions/, tasks/) stay on disk untouched.
 *
 * Pass `{ purge: true }` to also rm every emploke-owned subdirectory under
 * the workspace's workspaceDir. The workspaceDir itself is never removed —
 * that's user-owned and outside the manager's purview.
 */
export const removeWorkspace = (id: string, opts?: { purge?: boolean }) => {
  const qs = opts?.purge ? "?purge=1" : "";
  return mutate(`/api/workspaces/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
};

export const updateWorkspaceMetadata = async (
  id: string,
  patch: { name?: string },
): Promise<WorkspaceListItem> =>
  mutateJson<WorkspaceListItem>(
    `/api/workspaces/${encodeURIComponent(id)}`,
    jsonInit("PATCH", patch),
  );

// ─ Tasks (workspace-scoped) ─
//
// A Task is an autonomous one-shot agent invocation: dispatch a brief +
// optional details, the runtime spawns the agent, and the dashboard polls
// for terminal status. Each runtime publishes its own native event log; the
// server fetches the parsed timeline via the runtime's `readActivity`
// surface (`/api/.../tasks/:tid/activity`) which returns runtime-neutral
// `ActivityItem[]`. Filename, format, and on-disk layout of the underlying
// log stay inside the runtime adapter; the dashboard never sees them.

export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * Who launched this task (issue #119). String union to match
 * `@emploke/task` `TaskOrigin`. Dashboards default the list query to
 * `'standalone'` so workflow-launched tasks don't pollute the "what I
 * dispatched" view.
 */
export type TaskOrigin = "standalone" | "workflow";

/**
 * Why a task ended in `failed`. Discriminated by `kind` (issue #119).
 * Mirrors `@emploke/task` `TaskFailure` exactly. The dashboard is a
 * browser bundle so this is duplicated, not imported; keep in lockstep
 * with the entity definition when it changes.
 *
 *   - exited   → subprocess exited non-zero (carries `exit_code`)
 *   - signal   → terminated by OS signal (carries `signal`)
 *   - shutdown → TaskManager.shutdown() killed it
 *   - orphan   → recoverOrphaned marked a row whose owner crashed
 *   - internal → kernel-side fault
 *
 * Exit code / signal now live exclusively inside the typed `failure`
 * payload — v4 (issue #119) stopped writing the `metadata.exitCode` /
 * `metadata.exitSignal` mirrors.
 */
export type TaskFailure =
  | { kind: "exited"; exit_code: number; message: string }
  | { kind: "signal"; signal: string; message: string }
  | { kind: "shutdown"; message: string }
  | { kind: "orphan"; message: string }
  | { kind: "internal"; message: string };

/**
 * Why a task ended in `cancelled` (issue #119).
 *
 *   - user    → TaskManager.cancel(id) (operator request)
 *   - cascade → reconciliation / parent-side cancellation (v4 folded
 *               the pre-v4 'orphan' variant in here)
 */
export type TaskCancellation =
  | { kind: "user"; message: string }
  | { kind: "cascade"; message: string };

export interface TaskSuccess {
  output: string;
  deliverable?: unknown;
  artifacts?: readonly string[];
}

export interface TaskRecord {
  id: string;
  agent: string;
  /** Short single-line task title (≤ 200 chars). Always present. */
  brief: string;
  /** Optional long-form task body. Multi-line allowed. Omitted when not provided. */
  details?: string;
  /** Who launched this task (issue #119). */
  origin: TaskOrigin;
  status: TaskStatus;
  /**
   * Open-shape metadata. Includes runtime bookkeeping fields like
   * `workdir`, `runtime`, `runtimeSessionId`. v4 (issue #119) stopped
   * mirroring `exitCode` / `exitSignal` here — read from `failure.exit_code`
   * / `failure.signal` instead.
   */
  metadata: Record<string, unknown>;
  /** ISO 8601 string. */
  createdAt: string;
  /** ISO 8601 string. v4 (issue #119): non-null — set at create time. */
  startedAt: string;
  endedAt?: string;
  /** Populated iff status='succeeded'. */
  success?: TaskSuccess;
  /** Populated iff status='failed'. */
  failure?: TaskFailure;
  /** Populated iff status='cancelled'. */
  cancellation?: TaskCancellation;
}

/**
 * Optional server-side filters for `listTasks`. Mirrors the server's
 * `ListTaskOpts`. Omitted fields are not sent on the wire and the
 * server returns the matching set.
 */
export interface ListTasksOpts {
  agent?: string;
  runtime?: string;
  /** ISO 8601 (the server canonicalises). */
  createdSince?: string;
  /** Statuses to include. The server joins with `,` for the query. */
  statuses?: TaskStatus[];
  /**
   * Origin filter (issue #119). `'all'` disables the filter and
   * returns every origin; any other value is forwarded verbatim.
   * Default behaviour at call sites is `'standalone'` (matches the
   * dashboard's "what I dispatched" tab).
   */
  origin?: TaskOrigin | "all";
}

export const listTasks = (opts: ListTasksOpts = {}): Promise<TaskRecord[]> => {
  const qs = new URLSearchParams();
  if (opts.agent) qs.set("agent", opts.agent);
  if (opts.runtime) qs.set("runtime", opts.runtime);
  if (opts.createdSince) qs.set("createdSince", opts.createdSince);
  if (opts.statuses && opts.statuses.length > 0) qs.set("status", opts.statuses.join(","));
  if (opts.origin && opts.origin !== "all") qs.set("origin", opts.origin);
  const suffix = qs.toString() === "" ? "" : `?${qs.toString()}`;
  return fetchJson<TaskRecord[]>(`${workspacePrefix()}/tasks${suffix}`, "tasks");
};

export const getTask = (id: string): Promise<TaskRecord> =>
  fetchJson<TaskRecord>(`${workspacePrefix()}/tasks/${encodeURIComponent(id)}`, "task");

export const dispatchTask = async (
  agent: string,
  brief: string,
  details?: string,
  runtime?: string,
): Promise<TaskRecord> => {
  const body: Record<string, string> = { agent, brief };
  if (details !== undefined && details !== "") body.details = details;
  if (runtime !== undefined) body.runtime = runtime;
  return mutateJson<TaskRecord>(`${workspacePrefix()}/tasks`, jsonInit("POST", body));
};

export const deleteTask = (id: string, opts?: { purge?: boolean }) => {
  // Default ("archive") removes only the task metadata row — workdir
  // contents (stderr.log, agent artifacts) stay on disk so the user
  // can inspect the run after the fact; the runtime's own per-task
  // state (Copilot's events.jsonl / session-state dir) is also
  // preserved. `{ purge: true }` is the hard-delete path: row +
  // workdir + runtime state all go, in that order — runtime first
  // so a runtime failure aborts before any local removal (mirrors
  // session-delete semantics).
  //
  // Post-ADR-001 §3.5: server returns 409 when the task is still
  // running (mutate() throws the typed envelope; callers parse
  // `code` + `transition` to render the "cancel first" CTA).
  const qs = opts?.purge ? "?purge=1" : "";
  return mutate(`${workspacePrefix()}/tasks/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
};

/**
 * Cancel a running task (ADR-001 §3.11.1(a)). POSTs to
 * `/tasks/:id/cancel`; awaits the server's response (which itself
 * awaits `live.settled`), so the returned `TaskRecord` already has
 * status='cancelled' and the `cancellation` field populated.
 *
 * Throws on:
 *   - 404 → task gone (caller should drop the row from optimistic state)
 *   - 409 → task already terminal (caller should refresh + render
 *     whatever it became — the server includes the structured envelope
 *     `{ code: 'InvalidTransition', status, transition: 'cancel' }`
 *     so the UI can branch typed)
 *   - 503 → server is shutting down (one-shot toast + retry once the
 *     restart finishes)
 */
export const cancelTask = (id: string): Promise<TaskRecord> => {
  return mutateJson<TaskRecord>(`${workspacePrefix()}/tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
};

/**
 * Runtime-neutral activity timeline for a task. The runtime parses
 * its own event log into the {@link ActivityItem} discriminated
 * union below; the dashboard renders them without knowing which
 * runtime produced the underlying log.
 *
 * The shapes here MIRROR `@emploke/runtime`'s exports — they are
 * NOT imported because dashboard is a browser bundle that doesn't
 * pull from server-side packages. Keep them in lock-step manually
 * (the route-manifest test would catch divergence on the wire
 * shape; runtime-internal types like `Runtime` are excluded).
 *
 * Returns `null` (404 NoEventsYet) when the runtime doesn't implement
 * structured activity (e.g. a future runtime with no event log) or
 * when the log isn't on disk yet.
 */

export interface TokenUsage {
  input?: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
}

export interface SummaryStats {
  filesModified?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  toolCallsCount?: number;
  durationMs?: number;
  costUSD?: number;
  model?: string;
  premiumRequests?: number;
}

export interface Attachment {
  kind: "image" | "file";
  mimeType?: string;
  url?: string;
  data?: string;
  name?: string;
}

interface BaseActivityItem {
  seq: number;
  id?: string;
  parentSeq?: number;
  timestamp: string;
}

export interface UserActivityItem extends BaseActivityItem {
  kind: "user";
  text: string;
  attachments?: Attachment[];
}

export interface AssistantActivityItem extends BaseActivityItem {
  kind: "assistant";
  text: string;
  model?: string;
  tokens?: TokenUsage;
  stopReason?: string;
}

export interface ThinkingActivityItem extends BaseActivityItem {
  kind: "thinking";
  text: string;
  subject?: string;
}

export interface ToolCallActivityItem extends BaseActivityItem {
  kind: "tool_call";
  callId: string;
  name: string;
  args?: unknown;
  status: "running" | "success" | "error" | "cancelled";
  result?: unknown;
  display?: { content: string; markdown?: boolean };
  durationMs?: number;
}

export interface SystemActivityItem extends BaseActivityItem {
  kind: "system";
  text: string;
  level?: "info" | "warn" | "error";
  subKind?: string;
}

export interface SummaryActivityItem extends BaseActivityItem {
  kind: "summary";
  text?: string;
  tokens?: TokenUsage;
  stats?: SummaryStats;
}

export type ActivityItem =
  | UserActivityItem
  | AssistantActivityItem
  | ThinkingActivityItem
  | ToolCallActivityItem
  | SystemActivityItem
  | SummaryActivityItem;

export interface TruncationInfo {
  reason: "size_limit" | "page_limit";
  droppedBytes?: number;
  droppedItems?: number;
  hint?: string;
}

export interface TaskActivity {
  activity: ActivityItem[];
  result: string | null;
  totalItems: number;
  truncated?: TruncationInfo;
}

export interface FetchTaskActivityOpts {
  /**
   * Backward pagination: returns items with `seq < before`. Mutually
   * exclusive with `after`; both → 400 from the server.
   */
  before?: number;
  /**
   * Forward pagination: returns items with `seq > after`. Used by
   * polling and by callers walking head-to-tail.
   */
  after?: number;
  limit?: number;
}

export const fetchTaskActivity = async (
  id: string,
  opts: FetchTaskActivityOpts = {},
): Promise<TaskActivity | null> => {
  const usp = new URLSearchParams();
  if (opts.before !== undefined) usp.append("before", String(opts.before));
  if (opts.after !== undefined) usp.append("after", String(opts.after));
  if (opts.limit !== undefined) usp.append("limit", String(opts.limit));
  const qs = usp.toString();
  const url = `${workspacePrefix()}/tasks/${encodeURIComponent(id)}/activity${qs ? `?${qs}` : ""}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(await extractError(r));
  return r.json();
};

/**
 * Subscribe to live activity for a running task. Returns a handle
 * that can be `close()`d to release the SSE connection. Each new
 * {@link ActivityItem} arriving on the wire is delivered to
 * `onItem`; `onEnd` fires when the runtime finishes streaming
 * (task terminal) or the connection closes; `onError` fires on
 * transport / framing faults (the SSE layer auto-reconnects on
 * its own — `onError` is just for visibility).
 *
 * The `Last-Event-ID` reconnection header is set by the browser's
 * native EventSource using the `id:` field on each frame the
 * server emits — no manual bookkeeping required.
 */
export interface ActivityStreamHandle {
  close(): void;
}

export interface SubscribeTaskActivityOpts {
  /**
   * Resume from this seq (exclusive). Currently a placeholder for
   * future use — the SSE EventSource API doesn't support custom
   * headers cross-browser, so we cannot propagate this on FIRST
   * connect (no query-param fallback wired through yet). On
   * RECONNECT (transport drop), the browser sets `Last-Event-ID`
   * automatically from the `id:` field on each frame the server
   * emits — which the server route reads as `after`. So in the
   * reconnect case, resume Just Works without anyone passing this
   * field. For first-connect history catch-up the caller should do
   * a one-shot {@link fetchTaskActivity} `{ after }` and stitch the
   * result before subscribing.
   */
  after?: number;
  onItem: (item: ActivityItem) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

export const subscribeTaskActivity = (
  id: string,
  opts: SubscribeTaskActivityOpts,
): ActivityStreamHandle => {
  const url = `${workspacePrefix()}/tasks/${encodeURIComponent(id)}/activity/stream`;
  // EventSource doesn't support custom headers cross-browser, so we
  // can't pass Last-Event-ID on first connect via headers — but the
  // browser DOES set it on RECONNECT after a transport drop, which
  // is the case that matters most. For first-connect resume the
  // caller can do a one-shot fetchTaskActivity({ after }) before
  // subscribing and stitch the result into their state.
  const es = new EventSource(url);
  es.addEventListener("activity", (ev) => {
    try {
      const item = JSON.parse((ev as MessageEvent).data) as ActivityItem;
      opts.onItem(item);
    } catch (err) {
      opts.onError?.(err as Error);
    }
  });
  es.addEventListener("end", () => {
    opts.onEnd?.();
    es.close();
  });
  es.addEventListener("error", () => {
    // EventSource's spec auto-reconnects; we surface the error for
    // visibility but don't tear down. CLOSED state means truly dead
    // (server returned 4xx, won't retry).
    if (es.readyState === EventSource.CLOSED) {
      opts.onError?.(new Error("SSE connection closed"));
    }
  });
  return {
    close: () => es.close(),
  };
};

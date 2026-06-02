import type {
  Agent,
  AgentEntry,
  BlockedReason,
  Mcp,
  MissingDep,
  Skill,
  SkillEntry,
} from "@emploke/contracts";
import { fetchJson, jsonInit, mutate, mutateJson, workspacePrefix } from "./http.js";

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
 * Wire shape for an installed MCP — mirrors @emploke/catalog `Mcp`.
 * `mutable` controls whether the dashboard offers Edit (file: origin) vs
 * Sync (re-install from upstream for github: etc.).
 */
export type McpItem = Mcp;

export interface CatalogData {
  overview: OverviewData | null;
  skills: SkillEntry[];
  agents: AgentEntry[];
  mcps: McpItem[];
}

/** URL prefix for the active workspace's catalog endpoints. */
function catalogPrefix(): string {
  return `${workspacePrefix()}/catalog`;
}

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
 * The dashboard never asks the user "what kind of URL is this?" —
 * the user picks `url` or `file`. `url` means "the server's
 * `parseOrigin` sniffs the URL grammar and routes to the right
 * fetcher" (today: only `https://github.com/...`; tomorrow: npm /
 * oci / etc., with no UI change required). `file` always means the
 * local-file fetcher; the dashboard appends the `file:` scheme
 * transparently. Server semantics are unchanged — only the UX
 * vocabulary changed.
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
/**
 * User-facing install source. `"url"` covers every fetcher whose origin is
 * a URL (today: GitHub; future: npm, oci, etc.) — the catalog's `parseOrigin`
 * sniffs the URL grammar to pick the right fetcher. `"file"` always means
 * the local file fetcher (server-side `file:` scheme).
 *
 * The dashboard never asks the user "what kind of URL"; that's the
 * server's job. Picking the wrong fetcher would surface as a clear
 * "unsupported scheme" error from `parseOrigin`.
 */
export type InstallProvider = "url" | "file";

export interface InstallSource {
  /** Pick the source kind whose grammar matches your input. */
  provider: InstallProvider;
  /**
   * What the user typed:
   *  - `url`:  full URL (e.g. `https://github.com/owner/repo/tree/ref/path`).
   *            Pass-through to the wire — the server's `parseOrigin` picks the
   *            fetcher from the URL grammar.
   *  - `file`: absolute path on the **server's** filesystem (the dashboard
   *            and CLI both target the server, not the local machine).
   *            The client adds the `file:` prefix transparently.
   * Whitespace is trimmed.
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
 *   - `url`  + `https://github.com/owner/repo/tree/ref/path` →
 *     pass-through (the server's `parseOrigin` picks the fetcher
 *     from the URL grammar)
 *   - `file` + `/abs/path`            → `file:/abs/path`
 *   - `file` + `file:/abs/path`       → `file:/abs/path` (tolerate
 *     paste with prefix; trim and re-emit)
 *
 * Smuggling guard: `url` + a `file:` URI is rejected — the user
 * almost certainly meant to pick `file`. The mirror lives in the
 * CLI's `buildInstallOrigin` so both layers reject the same shape.
 *
 * Mirrors the assembly the CLI never had to do until the parallel
 * `--url` / `--file` flag refactor (PR #?). Tests in
 * `dashboard/test/buildOriginFromSource.test.ts` pin the contract.
 */
export function buildOriginFromSource(src: InstallSource): string {
  const trimmed = src.location.trim();
  switch (src.provider) {
    case "url":
      // Smuggling guard: if the user picked URL but typed a `file:` URI,
      // they almost certainly meant to pick File. Reject with a clear
      // error so we don't silently route a "file" install through a
      // mis-labelled provider. The mirror exists in CLI's flag validator.
      if (trimmed.startsWith("file:")) {
        throw new Error(
          'URL source cannot be a "file:" URI. Pick "File" and enter the path instead.',
        );
      }
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
  skill: Skill;
  status: "ready" | "blocked";
  blockedReason?: BlockedReason;
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
  agent: Agent;
  status: "ready" | "blocked";
  blockedReason?: BlockedReason;
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

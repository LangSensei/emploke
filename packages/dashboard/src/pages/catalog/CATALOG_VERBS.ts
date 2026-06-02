import type { CatalogKind } from "@emploke/contracts";
import {
  type AgentMetadataPatch,
  deleteAgent,
  deleteMcp,
  deleteSkill,
  disableAgent,
  enableAgent,
  getAgent,
  getMcp,
  getSkill,
  type InstallResult,
  type InstallSource,
  installAgent,
  installMcp,
  installSkill,
  patchAgentMetadata,
  patchSkillMetadata,
  type ResolveManifest,
  resolveAgentInstall,
  resolveSkillInstall,
  type SkillMetadataPatch,
  updateAgentContent,
  updateMcpContent,
  updateSkillContent,
} from "../../api";
import { KIND_TITLE } from "../../kindMeta";

/**
 * Plural URL segment that names a catalog tab — the value the
 * dashboard's React Router exposes via the `:tab` segment and
 * the historical key used by `KIND_LABEL`. The singular
 * {@link CatalogKind} from `@emploke/catalog` is the canonical
 * discriminator everywhere else; this tab type only exists to
 * mediate the URL / route boundary.
 */
export type CatalogTab = "agents" | "skills" | "mcps";

/** Singular kind → plural tab segment. */
export const KIND_TAB: Record<CatalogKind, CatalogTab> = {
  agent: "agents",
  skill: "skills",
  mcp: "mcps",
};

/** Plural tab segment → singular kind. Inverse of {@link KIND_TAB}. */
export const TAB_KIND: Record<CatalogTab, CatalogKind> = {
  agents: "agent",
  skills: "skill",
  mcps: "mcp",
};

/**
 * Normalised metadata shape used by the patch dialog's form mode.
 * MCPs do not surface a metadata form (only raw JSON edit), so this
 * shape is meaningless for them; {@link CatalogEntryDetail.meta} is
 * `null` in that case.
 */
export interface CatalogEntryMeta {
  description: string;
  version: string;
  /** Skill-only field. Empty string for agents (no agent prereqs concept). */
  prereqs: string;
  /** FQN strings, post-catalog-v2. */
  skills: string[];
  /** FQN strings, post-catalog-v2. */
  mcps: string[];
}

/**
 * Normalised detail payload returned by {@link CatalogKindVerbs.loadDetail}.
 *  - `content` is the raw anchor file text (SKILL.md / AGENTS.md / mcp.json).
 *  - `meta` is populated for skill + agent, `null` for mcp.
 *  - `agentDisabledByUser` is populated for agent, `null` for skill + mcp.
 *
 * The patch dialog reads these fields without re-discriminating on
 * the kind — `meta === null` ⇒ source-only edit; `agentDisabledByUser
 * !== null` ⇒ render the agent lifecycle toggle button.
 */
export interface CatalogEntryDetail {
  content: string;
  meta: CatalogEntryMeta | null;
  agentDisabledByUser: boolean | null;
}

/**
 * Unified PATCH body sent through {@link CatalogKindVerbs.patchMetadata}.
 * Per-kind adapters strip the fields each backend ignores: the agent
 * adapter drops `prereqs`, the skill adapter forwards it as-is.
 */
export interface CatalogMetadataPatch {
  description: string;
  version: string;
  /** Skill-only; agents ignore. `null` clears the field. */
  prereqs: string | null;
  /** `null` clears every dependency. */
  dependencies: { skills: string[]; mcps: string[] } | null;
}

/** Agent-only lifecycle verbs. `null` on every non-agent kind. */
export interface AgentLifecycleVerbs {
  enable: (name: string) => Promise<void>;
  disable: (name: string) => Promise<void>;
}

/**
 * Per-kind dispatch table — replaces the 10+ `if (kind === "agent" |
 * "skill" | "mcp")` chains that previously fanned through
 * `pages/Catalog.tsx`. Closes audit finding TN-B F2-4. Adding a
 * fourth catalog kind is now a matter of adding one entry here plus
 * its api wiring — the page + dialogs require no further edits.
 */
export interface CatalogKindVerbs {
  /** The singular kind discriminator this entry covers. */
  kind: CatalogKind;
  /** Plural tab segment — the URL the dashboard routes the kind under. */
  tab: CatalogTab;
  /** Title-case prose label (e.g. "Agent" / "Skill" / "MCP"). */
  title: string;
  /**
   * Editor language for the raw source editor in the patch dialog.
   * Drives `<CodeEditor language=...>` — markdown for SKILL/AGENT
   * anchor files, json for mcp.json specs.
   */
  sourceLanguage: "markdown" | "json";

  // ─── install ─────────────────────────────────────────────────────
  install: (src: InstallSource) => Promise<InstallResult>;
  /**
   * Two-phase install preview. `null` for MCPs — they are leaf
   * entries with no dep graph to render, and the FQN is recovered
   * from `_meta.name` server-side at install time.
   */
  resolveInstall: ((src: InstallSource) => Promise<ResolveManifest>) | null;

  // ─── remove ──────────────────────────────────────────────────────
  remove: (name: string) => Promise<void>;

  // ─── patch / source edit ─────────────────────────────────────────
  loadDetail: (name: string) => Promise<CatalogEntryDetail>;
  updateContent: (name: string, content: string) => Promise<void>;
  /**
   * Metadata PATCH for form-mode edits. `null` for MCPs (only raw
   * JSON edit is supported; their structure is the JSON itself).
   */
  patchMetadata: ((name: string, patch: CatalogMetadataPatch) => Promise<void>) | null;

  // ─── lifecycle ───────────────────────────────────────────────────
  /** Agent-only enable/disable verbs. `null` for skill + mcp. */
  lifecycle: AgentLifecycleVerbs | null;
}

// ─── kind → detail adapters ────────────────────────────────────────
//
// The api functions return per-kind detail shapes (`SkillDetail`,
// `AgentDetail`, `McpDetail`). The patch dialog wants a single
// normalised `CatalogEntryDetail` so it never re-discriminates.
// These adapters do the one-way projection.

const loadSkillDetail = async (name: string): Promise<CatalogEntryDetail> => {
  const d = await getSkill(name);
  const { skill, content } = d;
  return {
    content,
    meta: {
      description: skill.description ?? "",
      version: skill.version ?? "",
      prereqs: skill.prereqs ?? "",
      skills: (skill.dependencies?.skills ?? []).map((x) => x.fqn),
      mcps: (skill.dependencies?.mcps ?? []).map((x) => x.fqn),
    },
    agentDisabledByUser: null,
  };
};

const loadAgentDetail = async (name: string): Promise<CatalogEntryDetail> => {
  const d = await getAgent(name);
  const { agent, content } = d;
  return {
    content,
    meta: {
      description: agent.description ?? "",
      version: agent.version ?? "",
      // Agents have no per-entry prereqs at the metadata layer; carry an
      // empty string so the form shape stays uniform across skill/agent.
      prereqs: "",
      skills: (agent.dependencies?.skills ?? []).map((x) => x.fqn),
      mcps: (agent.dependencies?.mcps ?? []).map((x) => x.fqn),
    },
    agentDisabledByUser: agent.disabledByUser,
  };
};

const loadMcpDetail = async (name: string): Promise<CatalogEntryDetail> => {
  const d = await getMcp(name);
  return { content: d.content, meta: null, agentDisabledByUser: null };
};

// ─── unified patch body → per-kind patch body adapters ─────────────
//
// Mirror the inverse of the detail adapters: the dialog hands us one
// `CatalogMetadataPatch`; we shave the fields each backend ignores
// before forwarding.

const skillPatchAdapter = (name: string, patch: CatalogMetadataPatch): Promise<void> => {
  const body: SkillMetadataPatch = {
    description: patch.description,
    version: patch.version,
    prereqs: patch.prereqs,
    dependencies: patch.dependencies,
  };
  return patchSkillMetadata(name, body);
};

const agentPatchAdapter = (name: string, patch: CatalogMetadataPatch): Promise<void> => {
  // Agents have no `prereqs` field — drop it before forwarding so the
  // wire body matches `AgentMetadataPatch` exactly.
  const body: AgentMetadataPatch = {
    description: patch.description,
    version: patch.version,
    dependencies: patch.dependencies,
  };
  return patchAgentMetadata(name, body);
};

/**
 * Dispatch table for every per-kind operation the catalog page + its
 * dialogs perform. Lookup is `CATALOG_VERBS[kind]`; the page should
 * never branch on the kind discriminator directly.
 */
export const CATALOG_VERBS: Record<CatalogKind, CatalogKindVerbs> = {
  agent: {
    kind: "agent",
    tab: "agents",
    title: KIND_TITLE.agent,
    sourceLanguage: "markdown",
    install: installAgent,
    resolveInstall: resolveAgentInstall,
    remove: deleteAgent,
    loadDetail: loadAgentDetail,
    updateContent: updateAgentContent,
    patchMetadata: agentPatchAdapter,
    lifecycle: { enable: enableAgent, disable: disableAgent },
  },
  skill: {
    kind: "skill",
    tab: "skills",
    title: KIND_TITLE.skill,
    sourceLanguage: "markdown",
    install: installSkill,
    resolveInstall: resolveSkillInstall,
    remove: deleteSkill,
    loadDetail: loadSkillDetail,
    updateContent: updateSkillContent,
    patchMetadata: skillPatchAdapter,
    lifecycle: null,
  },
  mcp: {
    kind: "mcp",
    tab: "mcps",
    title: KIND_TITLE.mcp,
    sourceLanguage: "json",
    install: installMcp,
    resolveInstall: null,
    remove: deleteMcp,
    loadDetail: loadMcpDetail,
    updateContent: updateMcpContent,
    patchMetadata: null,
    lifecycle: null,
  },
};

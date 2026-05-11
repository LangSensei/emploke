/**
 * Backward-compatibility types preserved for consumers that haven't
 * migrated to the new entity classes (dashboard, runtime, etc.).
 *
 * These mirror the legacy `@emploke/catalog` types byte-for-byte so
 * HTTP responses and TypeScript imports keep working without churn.
 * The shapes intentionally avoid leaking the rich entity classes;
 * `CatalogManager.listSkillEntries()` etc. project entities into
 * these POJOs.
 */

export type CatalogKind = "skill" | "agent" | "mcp";
export type EntryStatus = "ready" | "blocked";
export type DependencyKind = "skill" | "mcp";

/**
 * A dependency reference is the canonical bare origin URI string of
 * the dependency (e.g. `"file:/abs/skills/web-search"` or
 * `"github:owner/repo/tree/main/skills/foo"`). The catalog resolves
 * an origin to a concrete fqn at install time.
 */
export type DependencyRef = string;

export interface MissingDep {
  readonly kind: DependencyKind;
  readonly name: string;
}

/**
 * A dep that IS installed but whose own status is `blocked` — surfaced
 * so cascade can be displayed (and so the dashboard can link to the
 * actual root cause).
 */
export interface BlockedDep {
  readonly kind: DependencyKind;
  /** FQN of the blocked dep (skills/agents) or MCP spec name. */
  readonly fqn: string;
}

/**
 * Structured "why is this entry blocked" payload. Populated iff
 * {@link SkillEntry.status} / {@link AgentEntry.status} is `"blocked"`.
 *
 * Self causes apply to the entry's own row; cascade causes are
 * inherited from a transitive dep being blocked or missing. The
 * dashboard branches on which buckets are populated to choose between
 * a self-CTA ("Acknowledge prereqs", "Enable", "Remove orphan") and
 * a cascade-CTA ("Fix dependency").
 */
export interface BlockedReason {
  // self causes
  readonly needsPrereqsAck?: true;
  /** Set only on agents — skills/mcps cannot be user-disabled. */
  readonly disabledByUser?: true;
  /** Set only on skills/mcps — agents are root entities and cannot be orphaned. */
  readonly orphaned?: true;
  // cascade causes
  readonly missingDeps?: readonly MissingDep[];
  readonly blockedDeps?: readonly BlockedDep[];
}

/**
 * POJO mirror of the {@link Skill} entity. Returned via
 * {@link CatalogManager.listSkillEntries} and friends so consumers
 * working with HTTP-shaped data don't need to import the entity class.
 */
export interface Skill {
  readonly fqn: string;
  readonly shortName: string;
  readonly scope: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs?: string;
  /**
   * True iff the entry can be edited via PUT/PATCH. Phase 2 rule:
   * mutable iff origin starts with `file:`. Remote-sourced entries
   * (`github:`, future `npm:`/`fqn:`) are read-only mirrors — to pick
   * up upstream changes, re-install via the same origin.
   */
  readonly mutable: boolean;
  /**
   * True iff the user has acknowledged the entry's `prereqs` text
   * (or the entry has no prereqs declared). Persisted per-installation,
   * NOT in frontmatter — it's a local opt-in.
   */
  readonly prereqsAck: boolean;
  /**
   * True iff this skill currently has zero reverse-deps (no installed
   * agent or skill references it). System-computed, recomputed after
   * every install/sync.
   */
  readonly orphaned: boolean;
  readonly dependencies?: {
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
  };
}

export interface Agent {
  readonly fqn: string;
  readonly shortName: string;
  readonly scope: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs?: string;
  /** See {@link Skill.mutable}. */
  readonly mutable: boolean;
  /** See {@link Skill.prereqsAck}. */
  readonly prereqsAck: boolean;
  /**
   * True iff the user has explicitly disabled this agent via the
   * Disable button. Skills and mcps don't have this flag (only agents
   * are user-launchable units worth pausing).
   */
  readonly disabledByUser: boolean;
  readonly dependencies?: {
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
  };
}

export interface McpMetadata {
  readonly name: string;
  readonly origin: string;
  /** See {@link Skill.mutable}. */
  readonly mutable: boolean;
  /** See {@link Skill.orphaned}. MCPs can be orphaned just like skills. */
  readonly orphaned: boolean;
}

export interface SkillEntry {
  readonly skill: Skill;
  readonly status: EntryStatus;
  readonly blockedReason?: BlockedReason;
  /** Legacy mirror of {@link BlockedReason.missingDeps}. */
  readonly missingDeps?: readonly MissingDep[];
}

export interface AgentEntry {
  readonly agent: Agent;
  readonly status: EntryStatus;
  readonly blockedReason?: BlockedReason;
  /** Legacy mirror of {@link BlockedReason.missingDeps}. */
  readonly missingDeps?: readonly MissingDep[];
}

export interface ResolvedSkill {
  readonly skill: Skill;
}

export interface ResolvedMcp {
  readonly name: string;
}

/**
 * Returned by {@link CatalogManager.resolveAgent}. Used by the runtime
 * to materialise a session workdir — it gets the agent + topologically
 * ordered skills + the set of mcp names whose content the runtime
 * will pull via `getMcpContent`.
 */
export interface AgentResolveResult {
  readonly agent: Agent;
  readonly skills: readonly ResolvedSkill[];
  readonly mcps: readonly ResolvedMcp[];
}

export interface SkillResolveResult {
  readonly skill: Skill;
  readonly skills: readonly ResolvedSkill[];
  readonly mcps: readonly ResolvedMcp[];
}

/** Per-call options for {@link CatalogManager.installSkillFromOrigin}. */
export interface InstallEntryOpts {
  readonly origin?: string;
}

/** Per-call options for {@link CatalogManager.installMcp}. */
export interface InstallMcpOpts {
  readonly name: string;
  readonly origin: string;
}

/**
 * Patch shape for {@link CatalogManager.updateSkillMetadata}.
 * Each field is optional; omitted fields preserve their current
 * value. Field-level validation happens inside the catalog (invalid
 * patches throw `FrontmatterError`).
 */
export interface SkillMetadataPatch {
  readonly description?: string;
  readonly version?: string;
  readonly prereqs?: string;
  readonly dependencies?: {
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
  } | null;
}

/** Patch shape for {@link CatalogManager.updateAgentMetadata}. */
export interface AgentMetadataPatch {
  readonly description?: string;
  readonly version?: string;
  readonly prereqs?: string | null;
  readonly dependencies?: {
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
  } | null;
}

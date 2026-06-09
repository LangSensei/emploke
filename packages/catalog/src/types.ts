/**
 * Wire-format DTOs for the catalog: the JSON shapes returned by
 * `CatalogService.listSkillEntries`, `getSkill`, `resolveAgent`, etc.
 * and consumed by the dashboard and runtime over HTTP.
 *
 * Kept distinct from the rich entity classes (`Skill`, `Agent`, `Mcp`)
 * so HTTP responses don't leak methods that wouldn't survive
 * serialisation, and so consumers that work in pure data-transfer
 * mode don't need to import the entity layer.
 *
 * `CatalogService` projects entities into these DTOs at the boundary
 * via the internal `projectSkillPojo` / `projectAgentPojo` /
 * `projectMcpMetadata` helpers.
 */

export type CatalogKind = "skill" | "agent" | "mcp";
export type EntryStatus = "ready" | "blocked";
export type DependencyKind = "skill" | "mcp";

/**
 * A dependency reference in the wire DTO. Identifies a dep by its
 * resolved fqn (the local catalog dep storage is keyed by fqn; the
 * install pipeline resolves origin → fqn at install time and writes to
 * the typed dep tables). Frontmatter wire shape carries origin URIs;
 * only the catalog DTO carries fqns.
 */
export interface DependencyRef {
  readonly fqn: string;
}

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
 * Wire DTO for a skill. Returned via
 * {@link CatalogService.listSkillEntries} and friends so consumers
 * working with HTTP-shaped data don't need to import the entity class.
 */
export interface Skill {
  readonly fqn: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs?: string;
  /**
   * True iff the entry can be edited via PUT/PATCH: mutable iff origin
   * starts with `file:`. Remote-sourced entries (`github:`, future
   * `npm:`/`fqn:`) are read-only mirrors — to pick up upstream changes,
   * re-install via the same origin.
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
  /** ISO 8601 UTC timestamp of first install. */
  readonly installedAt: string;
  /** ISO 8601 UTC timestamp of the most recent upsert. */
  readonly updatedAt: string;
  readonly dependencies?: {
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
  };
}

export interface Agent {
  readonly fqn: string;
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
  /** ISO 8601 UTC timestamp of first install. */
  readonly installedAt: string;
  /** ISO 8601 UTC timestamp of the most recent upsert. */
  readonly updatedAt: string;
  readonly dependencies?: {
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
    /**
     * Agent → agent edges. Top-level agents can declare other agents
     * as deps (the resolve pipeline cascade-installs them). Skills
     * cannot declare agent deps — only agents can.
     */
    readonly agents?: readonly DependencyRef[];
  };
}

export interface Mcp {
  /** Fully-qualified MCP spec name (`<namespace>/<short>`). */
  readonly fqn: string;
  readonly origin: string;
  /** See {@link Skill.mutable}. */
  readonly mutable: boolean;
  /** See {@link Skill.orphaned}. MCPs can be orphaned just like skills. */
  readonly orphaned: boolean;
  /** ISO 8601 UTC timestamp of first install. */
  readonly installedAt: string;
  /** ISO 8601 UTC timestamp of the most recent upsert. */
  readonly updatedAt: string;
}

export interface SkillEntry {
  readonly skill: Skill;
  readonly status: EntryStatus;
  readonly blockedReason?: BlockedReason;
  /** Convenience flattening of {@link BlockedReason.missingDeps}. */
  readonly missingDeps?: readonly MissingDep[];
}

export interface AgentEntry {
  readonly agent: Agent;
  readonly status: EntryStatus;
  readonly blockedReason?: BlockedReason;
  /** Convenience flattening of {@link BlockedReason.missingDeps}. */
  readonly missingDeps?: readonly MissingDep[];
}

export interface ResolvedSkill {
  readonly skill: Skill;
}

export interface ResolvedMcp {
  readonly fqn: string;
}

/**
 * Returned by {@link CatalogService.resolveAgent}. Used by the runtime
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

/**
 * Patch shape for {@link CatalogService.updateSkillMetadata}.
 *
 * The patch's `dependencies` field carries origin URI strings (the
 * same shape consumers paste into SKILL.md / AGENTS.md frontmatter)
 * because it's applied verbatim into the YAML block by
 * `applyFrontmatterPatch`. The DTO's read-side `dependencies` carries
 * `{ fqn }` objects derived from the dep tables.
 */
export interface SkillMetadataPatch {
  readonly description?: string;
  readonly version?: string;
  readonly prereqs?: string;
  readonly dependencies?: {
    readonly skills?: readonly string[];
    readonly mcps?: readonly string[];
  } | null;
}

/** Patch shape for {@link CatalogService.updateAgentMetadata}. */
export interface AgentMetadataPatch {
  readonly description?: string;
  readonly version?: string;
  readonly prereqs?: string | null;
  readonly dependencies?: {
    readonly skills?: readonly string[];
    readonly mcps?: readonly string[];
    readonly agents?: readonly string[];
  } | null;
}

/**
 * Resolved install body. Wire shape is identical (single `origin`
 * field), but the type alias is kept so downstream callers can
 * pattern-match against the validated form.
 */
export interface SkillInstallBody {
  readonly origin: string;
}

export interface AgentInstallBody {
  readonly origin: string;
}

export interface McpInstallBody {
  readonly origin: string;
}

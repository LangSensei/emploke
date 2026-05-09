/**
 * Domain types for @emploke/catalog.
 *
 * Aligned with MetaAgents spec:
 * https://github.com/metaagents-ai/metaagents
 */

export type CatalogKind = "skill" | "agent" | "mcp";

export type EntryStatus = "ready" | "disabled";

export type DependencyKind = "skill" | "mcp";

export interface MissingDep {
  readonly kind: DependencyKind;
  readonly name: string;
}

export interface SkillEntry {
  readonly skill: Skill;
  readonly status: EntryStatus;
  readonly missingDeps?: readonly MissingDep[];
}

export interface AgentEntry {
  readonly agent: Agent;
  readonly status: EntryStatus;
  readonly missingDeps?: readonly MissingDep[];
}

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly dependencies?: {
    readonly skills?: readonly string[];
    readonly mcps?: readonly string[];
  };
  readonly prereqs?: string;
}

export interface Agent {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly dependencies?: {
    readonly skills?: readonly string[];
    readonly mcps?: readonly string[];
  };
}

/**
 * A skill resolved by the catalog. The runtime obtains the actual file
 * contents via {@link CatalogManager.skillEntries} — paths are an
 * implementation detail of the FS repository, never exposed here.
 */
export interface ResolvedSkill {
  readonly skill: Skill;
}

/**
 * An MCP resolved by the catalog. The runtime obtains the JSON content
 * via {@link CatalogManager.getMcpContent} — there is no on-disk path
 * to expose because future SQLite-backed repositories don't have one.
 */
export interface ResolvedMcp {
  readonly name: string;
}

export interface AgentResolveResult {
  /** The resolved agent definition. */
  readonly agent: Agent;
  /** Transitive skill dependencies in topological order. */
  readonly skills: readonly ResolvedSkill[];
  /** All referenced MCPs (transitive). */
  readonly mcps: readonly ResolvedMcp[];
}

export interface SkillResolveResult {
  /** The resolved skill definition (the entry itself). */
  readonly skill: Skill;
  /**
   * Transitive closure of skills, INCLUDING the entry skill itself, in
   * topological order (deps before dependents). Useful for tooling that
   * needs to enumerate every skill that participates in this dispatch.
   */
  readonly skills: readonly ResolvedSkill[];
  /** All referenced MCPs (transitive). */
  readonly mcps: readonly ResolvedMcp[];
}

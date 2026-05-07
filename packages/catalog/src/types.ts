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

export interface ResolvedSkill {
  readonly skill: Skill;
  /** Absolute path to the skill directory. */
  readonly path: string;
}

export interface ResolvedMcp {
  readonly name: string;
  /** Absolute path to the MCP JSON file. */
  readonly path: string;
}

export interface AgentResolveResult {
  /** The resolved agent definition. */
  readonly agent: Agent;
  /** Absolute path to the agent's directory (contains AGENTS.md). */
  readonly agentPath: string;
  /** Transitive skill dependencies in topological order. */
  readonly skills: readonly ResolvedSkill[];
  /** All referenced MCPs (transitive). */
  readonly mcps: readonly ResolvedMcp[];
}

export interface SkillResolveResult {
  /** The resolved skill definition (the entry itself). */
  readonly skill: Skill;
  /** Absolute path to the skill's directory (contains SKILL.md). */
  readonly skillPath: string;
  /**
   * Transitive closure of skills, INCLUDING the entry skill itself, in
   * topological order (deps before dependents). Useful for tooling that
   * needs to enumerate every skill that participates in this dispatch.
   */
  readonly skills: readonly ResolvedSkill[];
  /** All referenced MCPs (transitive). */
  readonly mcps: readonly ResolvedMcp[];
}

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

export type ResolveEntry =
  | { readonly kind: "agent"; readonly agent: Agent; readonly path: string }
  | { readonly kind: "skill"; readonly skill: Skill; readonly path: string };

export interface ResolveResult {
  /** The resolved entry itself (agent or skill). */
  readonly entry: ResolveEntry;
  /** Transitive skill dependencies in topological order. */
  readonly skills: readonly ResolvedSkill[];
  /** All referenced MCPs. */
  readonly mcps: readonly ResolvedMcp[];
}

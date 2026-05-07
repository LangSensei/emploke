/**
 * Domain types for @emploke/catalog.
 *
 * Aligned with MetaAgents spec:
 * https://github.com/metaagents-ai/metaagents
 */

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

export interface ResolvedAgent {
  readonly agent: Agent;
  /** Absolute path to the agent directory. */
  readonly path: string;
}

export interface ResolveResult {
  readonly skills: readonly ResolvedSkill[];
  readonly mcps: readonly ResolvedMcp[];
}

// === Events ===

export interface SkillInstalled {
  readonly type: "SkillInstalled";
  readonly name: string;
  readonly path: string;
  readonly at: Date;
}

export interface SkillUpdated {
  readonly type: "SkillUpdated";
  readonly name: string;
  readonly path: string;
  readonly at: Date;
}

export interface SkillUninstalled {
  readonly type: "SkillUninstalled";
  readonly name: string;
  readonly at: Date;
}

export interface AgentInstalled {
  readonly type: "AgentInstalled";
  readonly name: string;
  readonly path: string;
  readonly at: Date;
}

export interface AgentUpdated {
  readonly type: "AgentUpdated";
  readonly name: string;
  readonly path: string;
  readonly at: Date;
}

export interface AgentUninstalled {
  readonly type: "AgentUninstalled";
  readonly name: string;
  readonly at: Date;
}

export interface McpInstalled {
  readonly type: "McpInstalled";
  readonly name: string;
  readonly path: string;
  readonly at: Date;
}

export interface McpUpdated {
  readonly type: "McpUpdated";
  readonly name: string;
  readonly path: string;
  readonly at: Date;
}

export interface McpUninstalled {
  readonly type: "McpUninstalled";
  readonly name: string;
  readonly at: Date;
}

export type CatalogEvent =
  | SkillInstalled
  | SkillUpdated
  | SkillUninstalled
  | AgentInstalled
  | AgentUpdated
  | AgentUninstalled
  | McpInstalled
  | McpUpdated
  | McpUninstalled;

export type CatalogEventHandler = (event: CatalogEvent) => void;

export interface EventBus<E> {
  publish(event: E): void;
  subscribe(handler: (event: E) => void): () => void;
}

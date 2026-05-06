/**
 * Domain types and events for @emploke/catalog.
 *
 * Design notes:
 *  - {@link Skill} is the pure domain object. It does NOT carry `path` —
 *    that is composed at runtime from `<root>/skills/<name>/`.
 *  - {@link ResolvedSkill} / {@link ResolvedMcp} attach the runtime path
 *    so substrates can copy/spawn without reconstructing the location.
 *  - emploke only reads `name`, `description`, `version`, `type`, `dependencies`
 *    from SKILL.md frontmatter. Other fields (prereq, license, tags, …) are
 *    transparently preserved on disk but never surfaced through the API.
 */

export interface Skill {
  readonly name: string;
  readonly description: string;
  /** Required. If frontmatter omits it, emploke fills "0.0.1" in memory only. */
  readonly version: string;
  /** Opaque to emploke; used by consumers to distinguish skill / squad / agent / etc. */
  readonly type?: string;
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
  /** Absolute path to the MCP JSON file. emploke never reads its content. */
  readonly path: string;
}

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
  | McpInstalled
  | McpUpdated
  | McpUninstalled;

export type CatalogEventHandler = (event: CatalogEvent) => void;

export interface EventBus<E> {
  publish(event: E): void;
  /** Returns an unsubscribe function. */
  subscribe(handler: (event: E) => void): () => void;
}

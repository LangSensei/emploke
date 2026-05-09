/**
 * Domain types for @emploke/catalog.
 *
 * Aligned with MetaAgents spec:
 * https://github.com/metaagents-ai/metaagents
 *
 * Post-#39: every catalog entry carries an `origin` URI (where it was
 * installed from) and a `scope` (organisational namespace, derived from
 * origin by default). The catalog identity is the FQN (`scope/name`); the
 * frontmatter `name` field stays a short kebab-case identifier and is
 * never rewritten on disk.
 */

export type CatalogKind = "skill" | "agent" | "mcp";

export type EntryStatus = "ready" | "disabled";

export type DependencyKind = "skill" | "mcp";

/**
 * One declared dependency in a SKILL.md / AGENTS.md frontmatter
 * `dependencies.{skills,mcps}` array. Replaces the pre-#39 plain
 * `string[]` form (clean break — `parseDependencies` rejects strings with
 * a `FrontmatterError`).
 *
 * Fields:
 *  - `name`  — short name (kebab-case, no `/`). Same convention as the
 *    target entry's frontmatter `name` field.
 *  - `origin` — required URI; the recursive installer fetches from here if
 *    the dep isn't already resolved in the catalog.
 *  - `scope` — optional override. Default scope is derived from `origin`
 *    via {@link scopeFromOrigin}; setting `scope` explicitly is rare,
 *    typically only when forking an upstream entry under a custom org name.
 *
 * The combination `(scope ?? scopeFromOrigin(origin)) + "/" + name` is the
 * resolution key — looked up in the catalog at install time, fetched from
 * `origin` and installed if missing.
 */
export interface DependencyRef {
  readonly name: string;
  readonly origin: string;
  readonly scope?: string;
}

export interface MissingDep {
  readonly kind: DependencyKind;
  /** FQN of the missing dependency (`scope/name`). */
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
  /**
   * Fully-qualified name (`scope/name`). Computed at install/scan time
   * from `(scope ?? scopeFromOrigin(origin)) + "/" + frontmatter.name`.
   * The frontmatter `name` field on disk stays a short identifier; this
   * `name` field is the *catalog identity*.
   */
  readonly name: string;
  /** Short kebab-case name, exactly as authored in the frontmatter. */
  readonly shortName: string;
  /** Organisational scope (kebab-case or reverse-DNS like `io.playwright`). */
  readonly scope: string;
  /** Origin URI the entry was installed from; required post-#39. */
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly dependencies?: {
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
  };
  readonly prereqs?: string;
}

export interface Agent {
  /** Fully-qualified name (`scope/name`). See {@link Skill.name}. */
  readonly name: string;
  readonly shortName: string;
  readonly scope: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly dependencies?: {
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
  };
}

/**
 * Stored side-channel metadata for an MCP. MCPs are JSON files (no
 * frontmatter), so origin is persisted in a `<name>.origin.json` sidecar
 * next to the JSON content rather than inside the file itself.
 */
export interface McpMetadata {
  readonly name: string;
  readonly shortName: string;
  readonly scope: string;
  readonly origin: string;
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

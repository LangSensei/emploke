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
 * `dependencies.{skills,mcps}` array.
 *
 * Two flavours, distinguished by the `kind` of the array containing
 * them (skill deps live under `dependencies.skills`, MCP deps under
 * `dependencies.mcps`):
 *
 *  - **Skill deps** (and agent deps where applicable): `name` is the
 *    SHORT kebab-case name; FQN is composed at install time as
 *    `(scope ?? scopeFromOrigin(origin)) + "/" + name`. Optional
 *    `scope:` overrides the origin-derived default.
 *
 *  - **MCP deps**: `name` is the FULL MCP-spec FQN
 *    (`<namespace>/<short>`, with the slash). MCPs don't participate
 *    in emploke's scope-mapping system; the spec name IS the catalog
 *    identity. The `scope:` field is ignored for MCP deps.
 *
 * Origin is required in both cases so the recursive installer
 * (`resolveInstall` / `applyInstall`) can fetch missing deps without
 * additional metadata lookups.
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
 * Stored metadata for an installed MCP. MCPs are JSON files; their
 * identity is the MCP-spec FQN (`<namespace>/<short>`) which lives at
 * the top of the JSON content as `_meta.name`. The `_meta.origin` key
 * carries the install-source URI in the same block.
 *
 * Unlike skills/agents, MCPs do NOT participate in emploke's
 * scope-mapping system — the spec name IS the catalog identity, no
 * derivation. `namespace` and `shortName` are decompositions of the
 * spec name, exposed for UI grouping.
 */
export interface McpMetadata {
  /** Full MCP spec FQN (`<namespace>/<short>`). */
  readonly name: string;
  /** First half of the spec name (everything before the `/`). */
  readonly namespace: string;
  /** Second half of the spec name (everything after the `/`). */
  readonly shortName: string;
  /** Origin URI the MCP was installed from. */
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

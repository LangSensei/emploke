/**
 * Public API of `@emploke/catalog`.
 *
 * Two surfaces:
 *  - **New, clean entity-based API**: per-entity services (Mcp/Skill/
 *    Agent), entity classes, repository interfaces, the cross-entity
 *    `CatalogManager` facade. Available under `agent.*`, `skill.*`,
 *    `mcp.*`, `facade.*` namespaces and at the top level.
 *  - **Legacy compat API** for in-tree consumers (server routes,
 *    runtime, dashboard). POJO type re-exports and convenience
 *    methods on `CatalogManager` mirror the pre-refactor shape.
 *
 * The legacy surface is the larger of the two by line count; over
 * time consumers will migrate to the new entity classes and the
 * compat re-exports can be removed.
 */

// ─── Compat: catalog-fetcher re-exports ──────────────
export {
  FetchError,
  type FetcherRegistry,
  normalizeOrigin,
  OriginParseError,
  type ParsedOrigin,
  parseOrigin,
} from "@emploke/catalog-fetcher";
// ─── Compat: errors (preserve legacy names) ──────────
//
// Old code imports per-entity errors directly. We re-export them
// at the top level so HTTP error-status mapping in
// server/_shared.ts can name them.
//
// Note: short alias names like `NotFound`, `OriginConflictError`,
// `NameInvalid`, `FrontmatterError`, `InvalidMcpJsonError` were
// removed. They masqueraded as cross-entity types but were Skill-only
// aliases, and the abstract base error sets `.name = new.target.name`
// — so any `switch (err.name)` keyed off the alias would never match a
// real instance. Use the per-entity class names instead.
export {
  AgentFrontmatterError,
  AgentNameInvalidError,
  AgentNotFoundError,
  AgentOriginConflictError,
  AgentPlanStaleError,
} from "./agent/errors.js";
export type { AgentFetcher } from "./agent/index.js";
// ─── Namespaces ─────────────────────────────────────────────
export * as agent from "./agent/index.js";

// ─── Top-level entity classes (rich API) ───────────────
export { Agent } from "./agent/index.js";
// ─── Compat: utility functions ─────────────────────────
export { applyFrontmatterPatch } from "./compat/frontmatter-patch.js";
export {
  type AgentInstallBody,
  type McpInstallBody,
  type SkillInstallBody,
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "./compat/install-input.js";
// ─── Compat: POJO types (legacy consumer shape) ────────
export type {
  Agent as AgentPojo,
  AgentEntry,
  AgentMetadataPatch,
  AgentResolveResult,
  BlockedDep,
  BlockedReason,
  CatalogKind,
  DependencyKind,
  DependencyRef,
  EntryStatus,
  InstallEntryOpts,
  InstallMcpOpts,
  McpMetadata,
  MissingDep,
  ResolvedMcp,
  ResolvedSkill,
  Skill as SkillPojo,
  SkillEntry,
  SkillMetadataPatch,
  SkillResolveResult,
} from "./compat/types.js";
export * as facade from "./facade/index.js";
// ─── Top-level facade ───────────────────────────────────
export {
  type CatalogConflict,
  type CatalogInstallFailure,
  type CatalogInstallResult,
  type CatalogInstallSkip,
  CatalogManager,
  type CatalogOptions,
  type CatalogPlan,
  type CatalogPlanNode,
  type CatalogSyncResult,
  HasDependentsError,
  type McpResolvedNode,
  type OrphanedEntry,
} from "./facade/index.js";
export {
  McpInvalidJsonError,
  McpNameInvalidError,
  McpNotFoundError,
  McpOriginConflictError,
} from "./mcp/errors.js";
// ─── Entity-fetcher contract types ─────────────────────
export type { McpFetcher } from "./mcp/index.js";
export * as mcp from "./mcp/index.js";
export { Mcp } from "./mcp/index.js";

// ─── Compat: codec re-exports ─────────────────────────
export {
  type McpFile as McpFileShape,
  type McpMeta,
  parse as parseMcpFile,
  stripMeta as stripMcpMeta,
  writeMeta as writeMcpMeta,
} from "./mcp/mcp-format.js";
export { splitMcpName, validateMcpName } from "./mcp/validate.js";
// ─── Origin mutability ──────────────────────────────
export { ImmutableOriginError, isOriginMutable } from "./origin-mutability.js";
export {
  PlanStaleError,
  SkillFrontmatterError,
  SkillNameInvalidError,
  SkillNotFoundError,
  SkillOriginConflictError,
} from "./skill/errors.js";
export type { SkillFetcher } from "./skill/index.js";
export * as skill from "./skill/index.js";
export { Skill } from "./skill/index.js";
// ─── Compat: validate utilities ─────────────────────
export {
  DEFAULT_SCOPE,
  makeFqn,
  splitFqn,
  validateFqn,
  validateScope,
  validateShortName,
} from "./skill/validate.js";

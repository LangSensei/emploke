/**
 * Public API of `@emploke/catalog`.
 *
 * Layout:
 *   - `Mcp` / `Skill` / `Agent` rich entity classes (with methods).
 *   - Per-entity service namespaces (`mcp.*`, `skill.*`, `agent.*`)
 *     and the cross-entity `CatalogManager` facade (`facade.*`).
 *   - DTOs (`SkillPojo`, `AgentPojo`, `McpMetadata`, `SkillEntry`,
 *     `BlockedReason`, …) are the wire shapes returned by the facade
 *     for HTTP serialisation; they intentionally avoid leaking
 *     entity-class methods.
 *   - Errors are exported per-entity (`SkillNotFoundError`,
 *     `AgentFrontmatterError`, `McpInvalidJsonError`, …) so HTTP
 *     status mapping in `server/_shared.ts` can name them.
 *
 * Note: short alias error names like `NotFound`, `OriginConflictError`,
 * `NameInvalid`, `FrontmatterError`, `InvalidMcpJsonError` were
 * removed. They masqueraded as cross-entity types but were Skill-only
 * aliases, and the abstract base error sets `.name = new.target.name`
 * — so any `switch (err.name)` keyed off the alias would never match a
 * real instance. Use the per-entity class names instead.
 */

// ─── catalog-fetcher re-exports ─────────────────────
export {
  FetchError,
  type FetcherRegistry,
  normalizeOrigin,
  OriginParseError,
  type ParsedOrigin,
  parseOrigin,
} from "@emploke/catalog-fetcher";

// ─── Errors ─────────────────────────────────────────
export {
  AgentFrontmatterError,
  AgentNameInvalidError,
  AgentNotFoundError,
  AgentOriginConflictError,
  AgentPlanStaleError,
} from "./agent/errors.js";
// ─── Entities + service namespaces ──────────────────
export type { AgentFetcher } from "./agent/index.js";
export * as agent from "./agent/index.js";
export { Agent } from "./agent/index.js";
// ─── Per-pkg migration arrays (consumed by server startup) ─
export { AGENT_MIGRATIONS } from "./agent/migrations/index.js";
// ─── Domain seedwork (catalog phase-2 foundation) ───
export type { AggregateRoot } from "./domain/seedwork/aggregate-root.js";
export { Entity } from "./domain/seedwork/entity.js";
export { ValueObject } from "./domain/seedwork/value-object.js";
// ─── Domain value objects (catalog phase-2 foundation) ─
export { AgentFqn } from "./domain/value-objects/agent-fqn.js";
export { McpName } from "./domain/value-objects/mcp-name.js";
export { Origin } from "./domain/value-objects/origin.js";
export { SkillFqn } from "./domain/value-objects/skill-fqn.js";
// ─── Wire DTOs (HTTP-shaped projections) ────────────
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
  McpMetadata,
  MissingDep,
  ResolvedMcp,
  ResolvedSkill,
  Skill as SkillPojo,
  SkillEntry,
  SkillMetadataPatch,
  SkillResolveResult,
} from "./dto/types.js";
// ─── Facade ─────────────────────────────────────────
export * as facade from "./facade/index.js";
export {
  type CatalogConflict,
  type CatalogInstalledEntry,
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
// ─── Frontmatter utility (markdown patch) ───────────
export { applyFrontmatterPatch } from "./frontmatter/patch.js";
export {
  McpInvalidJsonError,
  McpNameInvalidError,
  McpNotFoundError,
  McpOriginConflictError,
} from "./mcp/errors.js";
export type { McpFetcher } from "./mcp/index.js";
export * as mcp from "./mcp/index.js";
export { Mcp } from "./mcp/index.js";
// ─── MCP file format codec ──────────────────────────
export {
  type McpFile as McpFileShape,
  type McpMeta,
  parse as parseMcpFile,
  stripMeta as stripMcpMeta,
  writeMeta as writeMcpMeta,
} from "./mcp/mcp-format.js";
export { MCP_MIGRATIONS } from "./mcp/migrations/index.js";
export { splitMcpName, validateMcpName } from "./mcp/validate.js";
// ─── Composition root hook (issue #135 Phase 0) ─────
export { composeCatalogModule } from "./module.js";
// ─── Origin mutability ──────────────────────────────
export { ImmutableOriginError, isOriginMutable } from "./origin-mutability.js";
export {
  CyclicDependencyError,
  PlanStaleError,
  SkillFrontmatterError,
  SkillNameInvalidError,
  SkillNotFoundError,
  SkillOriginConflictError,
} from "./skill/errors.js";
export type { SkillFetcher } from "./skill/index.js";
export * as skill from "./skill/index.js";
export { Skill } from "./skill/index.js";
export { SKILL_MIGRATIONS } from "./skill/migrations/index.js";

// ─── FQN / scope / shortName helpers ────────────────
export {
  DEFAULT_SCOPE,
  makeFqn,
  splitFqn,
  validateFqn,
  validateScope,
  validateShortName,
} from "./skill/validate.js";
// ─── Install-body validators (HTTP boundary) ────────
export {
  type AgentInstallBody,
  type McpInstallBody,
  type SkillInstallBody,
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "./validate/install-input.js";

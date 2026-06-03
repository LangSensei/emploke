/**
 * Public API of `@emploke/catalog`.
 *
 * Layout:
 *   - `Mcp` / `Skill` / `Agent` rich entity classes (with methods).
 *   - Per-entity service namespaces (`mcp.*`, `skill.*`, `agent.*`)
 *     and the cross-entity `CatalogService` facade (`facade.*`).
 *   - DTOs are the wire shapes returned by the facade; they
 *     intentionally avoid leaking entity-class methods.
 *   - Errors are exported per-entity so HTTP status mapping in
 *     `server/_shared.ts` can name them.
 */

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
// ─── Composition root hook ─────────────────────────
export {
  type CatalogModule,
  type CatalogModuleOptions,
  composeCatalogModule,
} from "./compose.js";
// ─── Facade ─────────────────────────────────────────
export * as facade from "./facade/index.js";
export {
  type CatalogConflict,
  type CatalogInstalledEntry,
  type CatalogInstallFailure,
  type CatalogInstallResult,
  type CatalogInstallSkip,
  type CatalogOptions,
  type CatalogPlan,
  type CatalogPlanNode,
  CatalogService,
  type CatalogSyncResult,
  HasDependentsError,
  type McpResolvedNode,
  type OrphanedEntry,
} from "./facade/index.js";
// ─── Fetcher re-exports ─────────────────────────────
export {
  FetchError,
  type FetcherRegistry,
  normalizeOrigin,
  OriginParseError,
  type ParsedOrigin,
  parseOrigin,
} from "./fetcher/index.js";
export {
  McpInvalidJsonError,
  McpNameInvalidError,
  McpNotFoundError,
  McpOriginConflictError,
} from "./mcp/errors.js";
export type { McpFetcher } from "./mcp/index.js";
export * as mcp from "./mcp/index.js";
// ─── MCP file format codec ──────────────────────────
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
// ─── Drizzle schema (low-level row access for tests/migrations) ─
export * as schema from "./schema.js";
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
// ─── FQN / scope / shortName helpers ────────────────
export {
  DEFAULT_SCOPE,
  makeFqn,
  splitFqn,
  validateFqn,
  validateScope,
  validateShortName,
} from "./skill/validate.js";
// ─── Wire DTOs (HTTP-shaped projections) ────────────
export type {
  Agent,
  AgentEntry,
  AgentInstallBody,
  AgentMetadataPatch,
  AgentResolveResult,
  BlockedDep,
  BlockedReason,
  CatalogKind,
  DependencyKind,
  DependencyRef,
  EntryStatus,
  Mcp,
  McpInstallBody,
  MissingDep,
  ResolvedMcp,
  ResolvedSkill,
  Skill,
  SkillEntry,
  SkillInstallBody,
  SkillMetadataPatch,
  SkillResolveResult,
} from "./types.js";
// ─── Install-body validators (HTTP boundary) ────────
export {
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "./validate.js";

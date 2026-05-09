export {
  FetchError,
  type ParsedOrigin,
  OriginParseError,
  normalizeOrigin,
  parseOrigin,
  scopeFromOrigin,
} from "@emploke/catalog-fetcher";
export {
  CatalogError,
  CatalogStateError,
  CycleDetected,
  FrontmatterError,
  HasDependents,
  InvalidMcpJsonError,
  McpNameInvalidError,
  MissingDependencies,
  NameInvalid,
  NotFound,
  OriginConflictError,
  UnsupportedCatalogVersionError,
} from "./errors.js";
export { applyFrontmatterPatch, depRefToFqn, synthesizeOriginFromPath } from "./frontmatter.js";
export type {
  AgentMetadataPatch,
  CatalogOptions,
  InstallEntryOpts,
  InstallMcpOpts,
  ScanIssue,
  SkillMetadataPatch,
} from "./manager.js";
export { CatalogManager } from "./manager.js";
export {
  type AgentInstallBody,
  type McpInstallBody,
  type SkillInstallBody,
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "./install-input.js";
export {
  type AgentResolveNode,
  type McpResolveNode,
  type NodeStatus,
  type ResolveInstallInput,
  type ResolveManifest,
  type ResolveNode,
  type RootKind,
  type SkillResolveNode,
  resolveInstall,
} from "./resolve.js";
export {
  type ApplyInstallInput,
  type FailedEntry,
  type InstalledEntry,
  type InstallManifest,
  type SkippedEntry,
  applyInstall,
} from "./apply.js";
export { type CatalogConfig, CATALOG_CONFIG_VERSION, type CatalogRepository } from "./repositories/catalog-repository.js";
export { FsCatalogRepository } from "./repositories/fs-catalog-repository.js";
export { InMemoryCatalogRepository } from "./repositories/in-memory-catalog-repository.js";
export {
  type McpFileShape,
  type McpMeta,
  parseMcpFile,
  stripMcpMeta,
  writeMcpMeta,
} from "./mcp/mcp-frontmatter.js";
export {
  type ResolvedScope,
  type ScopeSource,
  ScopeResolver,
} from "./scope-resolver.js";
export type { CatalogEntryFile } from "./repositories/repository.js";
export type {
  Agent,
  AgentEntry,
  AgentResolveResult,
  CatalogKind,
  DependencyKind,
  DependencyRef,
  EntryStatus,
  McpMetadata,
  MissingDep,
  ResolvedMcp,
  ResolvedSkill,
  Skill,
  SkillEntry,
  SkillResolveResult,
} from "./types.js";
export {
  makeFqn,
  splitFqn,
  splitMcpName,
  validateFqn,
  validateMcpName,
  validateScope,
  validateShortName,
} from "./validate.js";

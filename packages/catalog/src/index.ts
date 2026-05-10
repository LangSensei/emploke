export {
  FetchError,
  normalizeOrigin,
  OriginParseError,
  type ParsedOrigin,
  parseOrigin,
} from "@emploke/catalog-fetcher";
export {
  type ApplyInstallInput,
  applyInstall,
  type FailedEntry,
  type InstalledEntry,
  type InstallManifest,
  type SkippedEntry,
} from "./apply.js";
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
} from "./errors.js";
export {
  applyFrontmatterPatch,
  DEFAULT_SCOPE,
  depRefToFqn,
  synthesizeOriginFromPath,
} from "./frontmatter.js";
export {
  type AgentInstallBody,
  type McpInstallBody,
  type SkillInstallBody,
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "./install-input.js";
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
  type McpFileShape,
  type McpMeta,
  parseMcpFile,
  stripMcpMeta,
  writeMcpMeta,
} from "./mcp/mcp-frontmatter.js";
export type { CatalogEntryFile } from "./repositories/repository.js";
export {
  type AgentResolveNode,
  type McpResolveNode,
  type NodeStatus,
  type ResolveInstallInput,
  type ResolveManifest,
  type ResolveNode,
  type RootKind,
  resolveInstall,
  type SkillResolveNode,
} from "./resolve.js";
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

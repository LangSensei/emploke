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
  MissingDependencies,
  NameInvalid,
  NotFound,
  OriginConflictError,
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
  type DeepInstallInput,
  type FailedEntry,
  type InstallManifest,
  type InstalledEntry,
  type RootKind,
  type SkippedEntry,
  deepInstall,
} from "./deep-install.js";
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
export { makeFqn, splitFqn, validateFqn, validateScope, validateShortName } from "./validate.js";

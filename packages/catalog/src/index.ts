export {
  CatalogError,
  CatalogStateError,
  CycleDetected,
  FetchError,
  FrontmatterError,
  HasDependents,
  MissingDependencies,
  NameInvalid,
  NotFound,
  OriginConflictError,
  OriginParseError,
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
export { normalizeOrigin, parseOrigin, scopeFromOrigin } from "./origin.js";
export type { ParsedOrigin } from "./origin.js";
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

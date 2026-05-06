/**
 * @emploke/catalog — Skill + MCP dependency-aware registry (file-system backed).
 *
 * Public API surface:
 *   - {@link Catalog}        the only class consumers instantiate
 *   - Domain types:          {@link Skill}, {@link ResolvedSkill}, {@link ResolvedMcp}
 *   - Events:                {@link CatalogEvent}, {@link EventBus}
 *   - Errors:                {@link CatalogError} and subclasses
 *
 * Filesystem layout (hard-coded, not configurable):
 *   <root>/skills/<name>/SKILL.md     (frontmatter + body; emploke parses 4 fields, body untouched)
 *   <root>/mcps/<name>.json           (single JSON file; emploke writes it but never reads contents)
 */

export { Catalog } from "./catalog.js";
export {
  CatalogError,
  CatalogStateError,
  CycleDetected,
  FrontmatterError,
  HasDependents,
  MissingDependencies,
  NameConflict,
  NameInvalid,
  NotFound,
} from "./errors.js";
export type {
  CatalogEvent,
  CatalogEventHandler,
  EventBus,
  McpInstalled,
  McpUninstalled,
  McpUpdated,
  ResolvedMcp,
  ResolvedSkill,
  Skill,
  SkillInstalled,
  SkillUninstalled,
  SkillUpdated,
} from "./types.js";

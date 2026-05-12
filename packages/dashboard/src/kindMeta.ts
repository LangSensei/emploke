/**
 * Single source of truth for catalog entity-kind labels and icons.
 *
 * Used in:
 *   - {@link EntryGrid}'s card kind-tag
 *   - {@link ResolveTree}'s tree-row kind icon
 *   - {@link DetailDialog}'s modal title
 *   - {@link Catalog}'s tab + Install button labels
 *
 * Drift here was the source of an inconsistency where the resolve
 * preview used `🔌` for mcps but the catalog grid showed no icon at
 * all because mcps went through a separate component (McpGrid)
 * rather than EntryGrid. Centralising the table makes that class of
 * drift impossible.
 */

export type EntityKind = "agent" | "skill" | "mcp";

/**
 * Single emoji glyph used wherever a kind needs visual differentiation.
 * Picked for legibility at 12-16px and good rendering across major OSes.
 */
export const KIND_ICON: Record<EntityKind, string> = {
  agent: "🤖",
  skill: "🛠",
  mcp: "🔌",
};

/**
 * Uppercase tag used in card headers and resolve-tree pills. The
 * uppercase style is the visual convention for "type / kind" tags
 * across the dashboard (see also AGENT/SKILL/MCP labels in v0-style
 * mockups). Use {@link KIND_TITLE} for human-friendly contexts.
 */
export const KIND_TAG: Record<EntityKind, string> = {
  agent: "AGENT",
  skill: "SKILL",
  mcp: "MCP",
};

/**
 * Title-case label for prose contexts: modal titles, button text,
 * empty-state messages. e.g. `Install Skill`, `Edit Agent`.
 */
export const KIND_TITLE: Record<EntityKind, string> = {
  agent: "Agent",
  skill: "Skill",
  mcp: "MCP",
};

/**
 * Plural form for sentences like "no agents installed" or
 * "{N} skills". MCPs stay uppercase per spec convention.
 */
export const KIND_PLURAL: Record<EntityKind, string> = {
  agent: "agents",
  skill: "skills",
  mcp: "MCPs",
};

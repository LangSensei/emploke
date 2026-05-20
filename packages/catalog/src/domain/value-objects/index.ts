/**
 * Catalog domain value objects. Each VO is the single construction
 * point for its underlying invariant: callers pass strings in, the
 * VO either parses successfully or throws — there is no "valid"
 * VO instance with bad data inside.
 */

export { AgentFqn } from "./agent-fqn.js";
export { McpName } from "./mcp-name.js";
export { Origin } from "./origin.js";
export { SkillFqn } from "./skill-fqn.js";

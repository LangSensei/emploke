/**
 * In-memory repositories for fast unit tests.
 *
 * Production code never imports from this subpath; it constructs `Fs*Repository`
 * implementations via the `CatalogManager` facade.
 */

export { InMemoryAgentRepository } from "./src/repositories/in-memory-agent-repository.js";
export { InMemoryMcpRepository } from "./src/repositories/in-memory-mcp-repository.js";
export { InMemorySkillRepository } from "./src/repositories/in-memory-skill-repository.js";
export type {
  AgentRepository,
  DocumentRepoEntry,
  McpRepoEntry,
  McpRepository,
  SkillRepository,
} from "./src/repositories/repository.js";

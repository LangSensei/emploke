import type { Mcp } from "./mcp-entity.js";

/**
 * Persistence boundary for {@link Mcp} domain entities.
 *
 * v2 (issue #122) renames the storage layer's terminology from
 * `name`/`content` to `fqn`/`spec` to match the rest of the catalog.
 */
export interface McpRepository {
  add(mcp: Mcp): Promise<void>;
  findByFqn(fqn: string): Promise<Mcp | null>;
  findByOrigin(origin: string): Promise<Mcp | null>;
  delete(fqn: string): Promise<void>;
  findAll(): Promise<Mcp[]>;
  /** Indexed reverse-dep: agents that list `targetFqn` in agent_mcp_dependencies. */
  findDependentAgents(targetFqn: string): Promise<string[]>;
  /** Indexed reverse-dep: skills that list `targetFqn` in skill_mcp_dependencies. */
  findDependentSkills(targetFqn: string): Promise<string[]>;
  close?(): void;
}

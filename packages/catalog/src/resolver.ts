import type { AgentCatalog } from "./agent/agent-catalog.js";
import { type GraphNode, resolveTopological } from "./graph.js";
import type { McpCatalog } from "./mcp/mcp-catalog.js";
import type { SkillCatalog } from "./skill/skill-catalog.js";
import type {
  AgentResolveResult,
  ResolvedMcp,
  ResolvedSkill,
  SkillResolveResult,
} from "./types.js";

/**
 * Resolves dependency graphs for agents and skills.
 *
 * Returns logical pointers (entity records + names), not filesystem paths —
 * the runtime obtains actual content via {@link CatalogManager.skillEntries}
 * / {@link CatalogManager.agentEntries} / {@link CatalogManager.getMcpContent}
 * so a future SQLite-backed repository works the same way as the FS one.
 */
export class Resolver {
  constructor(
    private readonly skills: SkillCatalog,
    private readonly agents: AgentCatalog,
    private readonly mcps: McpCatalog,
  ) {}

  resolveAgent(name: string): AgentResolveResult {
    const agent = this.agents.get(name);
    if (!agent) {
      // Distinguish "exists as something else" from "does not exist at all".
      if (this.skills.has(name)) {
        throw new Error(`"${name}" is a skill, not an agent — use resolveSkill() instead`);
      }
      throw new Error(`agent not found in catalog: "${name}"`);
    }

    const rootDeps = [...(agent.dependencies?.skills ?? []), ...(agent.dependencies?.mcps ?? [])];
    const { skills, mcps } = this.#resolveDeps(rootDeps);

    return { agent, skills, mcps };
  }

  resolveSkill(name: string): SkillResolveResult {
    const skill = this.skills.get(name);
    if (!skill) {
      if (this.agents.has(name)) {
        throw new Error(`"${name}" is an agent, not a skill — use resolveAgent() instead`);
      }
      throw new Error(`skill not found in catalog: "${name}"`);
    }

    const rootDeps = [...(skill.dependencies?.skills ?? []), ...(skill.dependencies?.mcps ?? [])];
    const { skills: depSkills, mcps } = this.#resolveDeps(rootDeps);

    // Include the entry skill itself at the END (topological order: deps first).
    const skills: ResolvedSkill[] = [...depSkills, { skill }];

    return { skill, skills, mcps };
  }

  /**
   * Shared traversal: walks `rootDeps` topologically and partitions the
   * result into skills + mcps. Agents are rejected at the dependency level
   * (they cannot be deps of anything).
   */
  #resolveDeps(rootDeps: readonly string[]): {
    skills: ResolvedSkill[];
    mcps: ResolvedMcp[];
  } {
    const lookup = (n: string): GraphNode | undefined => {
      const skill = this.skills.get(n);
      if (skill) {
        return {
          name: n,
          dependencies: [
            ...(skill.dependencies?.skills ?? []),
            ...(skill.dependencies?.mcps ?? []),
          ],
        };
      }
      if (this.mcps.has(n)) {
        return { name: n, dependencies: [] };
      }
      if (this.agents.has(n)) {
        throw new Error(
          `"${n}" is an agent and cannot be a dependency (agents can only depend on skills and mcps)`,
        );
      }
      return undefined;
    };

    const resolved = resolveTopological(rootDeps, lookup);
    const skills: ResolvedSkill[] = [];
    const mcps: ResolvedMcp[] = [];
    for (const node of resolved) {
      const s = this.skills.get(node.name);
      if (s) {
        skills.push({ skill: s });
      } else if (this.mcps.has(node.name)) {
        mcps.push({ name: node.name });
      }
    }
    return { skills, mcps };
  }
}

import { join } from "node:path";
import type { AgentStore } from "./agent/agent-store.js";
import { type GraphNode, resolveTopological } from "./graph.js";
import type { McpStore } from "./mcp/mcp-store.js";
import type { SkillStore } from "./skill/skill-store.js";
import type {
  AgentResolveResult,
  ResolvedMcp,
  ResolvedSkill,
  SkillResolveResult,
} from "./types.js";
import { nameToPath } from "./validate.js";

export class Resolver {
  constructor(
    private readonly skills: SkillStore,
    private readonly agents: AgentStore,
    private readonly mcps: McpStore,
    private readonly catalogDir: string,
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

    return {
      agent,
      agentPath: join(this.catalogDir, "agents", nameToPath(name)),
      skills,
      mcps,
    };
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
    const skillPath = join(this.catalogDir, "skills", nameToPath(name));
    const skills: ResolvedSkill[] = [...depSkills, { skill, path: skillPath }];

    return { skill, skillPath, skills, mcps };
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
      if (this.skills.has(node.name)) {
        skills.push({
          skill: this.skills.get(node.name)!,
          path: join(this.catalogDir, "skills", nameToPath(node.name)),
        });
      } else if (this.mcps.has(node.name)) {
        mcps.push({
          name: node.name,
          path: join(this.catalogDir, "mcps", `${nameToPath(node.name)}.json`),
        });
      }
    }
    return { skills, mcps };
  }
}

import { join } from "node:path";
import { NotFound } from "./errors.js";
import { type GraphNode, resolveTopological } from "./graph.js";
import type { AgentStore } from "./agent/agent-store.js";
import type { McpStore } from "./mcp/mcp-store.js";
import type { SkillStore } from "./skill/skill-store.js";
import type { ResolvedMcp, ResolvedSkill, ResolveResult } from "./types.js";
import { nameToPath } from "./validate.js";

export class Resolver {
  constructor(
    private readonly skills: SkillStore,
    private readonly agents: AgentStore,
    private readonly mcps: McpStore,
    private readonly catalogDir: string,
  ) {}

  resolve(name: string): ResolveResult {
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
      return undefined;
    };

    let rootDeps: readonly string[];
    const agent = this.agents.get(name);
    const skill = this.skills.get(name);
    if (agent) {
      rootDeps = [
        ...(agent.dependencies?.skills ?? []),
        ...(agent.dependencies?.mcps ?? []),
      ];
    } else if (skill) {
      rootDeps = [
        ...(skill.dependencies?.skills ?? []),
        ...(skill.dependencies?.mcps ?? []),
      ];
    } else {
      throw new NotFound("agent or skill", name);
    }

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
          path: join(this.catalogDir, "mcps", nameToPath(node.name) + ".json"),
        });
      }
    }

    return { skills, mcps };
  }
}

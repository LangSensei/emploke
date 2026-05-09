import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FrontmatterError, HasDependents, NotFound } from "../errors.js";
import { applyFrontmatterPatch, frontmatterToAgent, parseFrontmatter } from "../frontmatter.js";
import type { GraphNode } from "../graph.js";
import type { AgentRepository } from "../repositories/repository.js";
import type { Agent } from "../types.js";
import { validateName } from "../validate.js";

export type AgentMetadataPatch = Partial<{
  description: string;
  version: string;
  dependencies: { skills?: string[]; mcps?: string[] } | null;
}>;

/**
 * Business-logic facade over an {@link AgentRepository}.
 *
 * The Store owns frontmatter parsing, name validation, the in-memory cache,
 * and dependency-graph nodes. All catalog-internal IO is delegated to the
 * repository — the Store only touches user-provided source directories
 * directly (in `install()`).
 */
export class AgentStore {
  private readonly agents = new Map<string, Agent>();

  constructor(private readonly repository: AgentRepository) {}

  async install(sourceDir: string): Promise<Agent> {
    const sourcePath = join(sourceDir, "AGENTS.md");
    const content = await readFile(sourcePath, "utf8");
    const { data } = parseFrontmatter(content, sourcePath);
    const agent = frontmatterToAgent(data, sourcePath);
    validateName(agent.name);

    await this.repository.installFromDir(agent.name, sourceDir);
    this.agents.set(agent.name, agent);
    return agent;
  }

  async getContent(name: string): Promise<string> {
    // Defense-in-depth: validate before going to the repo. Repos validate too,
    // but rejecting at the Store boundary keeps NotFound semantics for invalid
    // names rather than leaking a path-traversal error upstream.
    validateName(name);
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const content = await this.repository.read(name);
    if (content === null) throw new NotFound("agent", name);
    return content;
  }

  async updateContent(name: string, content: string): Promise<Agent> {
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const sourcePath = `repository:agents/${name}/AGENTS.md`;
    const { data } = parseFrontmatter(content, sourcePath);
    const agent = frontmatterToAgent(data, sourcePath);
    if (agent.name !== name) {
      throw new FrontmatterError(
        sourcePath,
        `cannot rename via edit: frontmatter name "${agent.name}" must equal "${name}". Remove and re-install instead.`,
      );
    }
    validateName(agent.name);

    await this.repository.write(name, content);
    this.agents.set(name, agent);
    return agent;
  }

  async updateMetadata(name: string, patch: AgentMetadataPatch): Promise<Agent> {
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const sourcePath = `repository:agents/${name}/AGENTS.md`;
    const existing = await this.repository.read(name);
    if (existing === null) throw new NotFound("agent", name);

    const merge: Record<string, unknown> = {};
    if (patch.description !== undefined) merge.description = patch.description;
    if (patch.version !== undefined) merge.version = patch.version;
    if (patch.dependencies !== undefined) {
      const d = patch.dependencies;
      if (d === null) {
        merge.dependencies = null;
      } else {
        const skills = d.skills ?? [];
        const mcps = d.mcps ?? [];
        if (skills.length === 0 && mcps.length === 0) {
          merge.dependencies = null;
        } else {
          const obj: { skills?: readonly string[]; mcps?: readonly string[] } = {};
          if (skills.length > 0) obj.skills = skills;
          if (mcps.length > 0) obj.mcps = mcps;
          merge.dependencies = obj;
        }
      }
    }

    const newContent = applyFrontmatterPatch(existing, merge);
    const { data } = parseFrontmatter(newContent, sourcePath);
    const agent = frontmatterToAgent(data, sourcePath);
    if (agent.name !== name) {
      throw new FrontmatterError(
        sourcePath,
        `metadata patch must not change name (current="${name}", patched="${agent.name}")`,
      );
    }

    await this.repository.write(name, newContent);
    this.agents.set(name, agent);
    return agent;
  }

  async remove(name: string, getDependents?: (name: string) => string[]): Promise<void> {
    validateName(name);
    if (!this.agents.has(name)) throw new NotFound("agent", name);

    if (getDependents) {
      const dependents = getDependents(name);
      if (dependents.length > 0) throw new HasDependents(name, dependents);
    }

    await this.repository.delete(name);
    this.agents.delete(name);
  }

  get(name: string): Agent | null {
    return this.agents.get(name) ?? null;
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  graphNodes(): GraphNode[] {
    return [...this.agents].map(([name, agent]) => ({
      name,
      dependencies: [...(agent.dependencies?.skills ?? []), ...(agent.dependencies?.mcps ?? [])],
    }));
  }

  async scan(): Promise<{ path: string; reason: string }[]> {
    this.agents.clear();
    const issues: { path: string; reason: string }[] = [];
    const entries = await this.repository.scan();
    for (const { content, sourcePath } of entries) {
      try {
        const { data } = parseFrontmatter(content, sourcePath);
        const agent = frontmatterToAgent(data, sourcePath);
        this.agents.set(agent.name, agent);
      } catch (e) {
        issues.push({ path: sourcePath, reason: (e as Error).message });
      }
    }
    return issues;
  }
}

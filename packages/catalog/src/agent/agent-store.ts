import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceDir, pathExists } from "../atomic.js";
import { FrontmatterError, HasDependents, NotFound } from "../errors.js";
import { applyFrontmatterPatch, frontmatterToAgent, parseFrontmatter } from "../frontmatter.js";
import type { GraphNode } from "../graph.js";
import type { Agent } from "../types.js";
import { nameToPath, validateName } from "../validate.js";

export type AgentMetadataPatch = Partial<{
  description: string;
  version: string;
  dependencies: { skills?: string[]; mcps?: string[] } | null;
}>;

export class AgentStore {
  private readonly agents = new Map<string, Agent>();

  constructor(private readonly catalogDir: string) {}

  private get baseDir() {
    return join(this.catalogDir, "agents");
  }

  async install(sourceDir: string): Promise<Agent> {
    const agentMd = join(sourceDir, "AGENTS.md");
    const content = await readFile(agentMd, "utf8");
    const { data } = parseFrontmatter(content, agentMd);
    const agent = frontmatterToAgent(data, agentMd);
    validateName(agent.name);

    const destDir = join(this.baseDir, nameToPath(agent.name));
    const exists = this.agents.has(agent.name);
    await atomicReplaceDir(sourceDir, destDir);
    this.agents.set(agent.name, agent);
    return agent;
  }

  async getContent(name: string): Promise<string> {
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const agentMd = join(this.baseDir, nameToPath(name), "AGENTS.md");
    return readFile(agentMd, "utf8");
  }

  async updateContent(name: string, content: string): Promise<Agent> {
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const agentMd = join(this.baseDir, nameToPath(name), "AGENTS.md");

    const { data } = parseFrontmatter(content, agentMd);
    const agent = frontmatterToAgent(data, agentMd);
    if (agent.name !== name) {
      throw new FrontmatterError(
        agentMd,
        `cannot rename via edit: frontmatter name "${agent.name}" must equal "${name}". Remove and re-install instead.`,
      );
    }
    validateName(agent.name);

    await mkdir(join(this.baseDir, nameToPath(name)), { recursive: true });
    await writeFile(agentMd, content, "utf8");
    this.agents.set(name, agent);
    return agent;
  }

  async updateMetadata(name: string, patch: AgentMetadataPatch): Promise<Agent> {
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const agentMd = join(this.baseDir, nameToPath(name), "AGENTS.md");
    const existing = await readFile(agentMd, "utf8");

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
    const { data } = parseFrontmatter(newContent, agentMd);
    const agent = frontmatterToAgent(data, agentMd);
    if (agent.name !== name) {
      throw new FrontmatterError(
        agentMd,
        `metadata patch must not change name (current="${name}", patched="${agent.name}")`,
      );
    }

    await writeFile(agentMd, newContent, "utf8");
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

    const destDir = join(this.baseDir, nameToPath(name));
    await rm(destDir, { recursive: true, force: true });
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
    if (!(await pathExists(this.baseDir))) return issues;
    await this.scanDir(this.baseDir, null, issues);
    return issues;
  }

  private async scanDir(
    dir: string,
    scope: string | null,
    issues: { path: string; reason: string }[],
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(dir, entry.name);
      const agentMd = join(entryPath, "AGENTS.md");

      if (await pathExists(agentMd)) {
        try {
          const content = await readFile(agentMd, "utf8");
          const { data } = parseFrontmatter(content, agentMd);
          const agent = frontmatterToAgent(data, agentMd);
          this.agents.set(agent.name, agent);
        } catch (e) {
          issues.push({ path: agentMd, reason: (e as Error).message });
        }
      } else if (scope === null) {
        await this.scanDir(entryPath, entry.name, issues);
      }
    }
  }
}

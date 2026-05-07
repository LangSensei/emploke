import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceDir, pathExists } from "../atomic.js";
import { NotFound } from "../errors.js";
import { frontmatterToAgent, parseFrontmatter } from "../frontmatter.js";
import type { GraphNode } from "../graph.js";
import type { Agent, CatalogEvent, EventBus } from "../types.js";
import { nameToPath, validateName } from "../validate.js";

export class AgentStore {
  private readonly agents = new Map<string, Agent>();

  constructor(
    private readonly catalogDir: string,
    private readonly events: EventBus<CatalogEvent>,
  ) {}

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

    this.events.publish({
      type: exists ? "AgentUpdated" : "AgentInstalled",
      name: agent.name,
      path: destDir,
      at: new Date(),
    });
    return agent;
  }

  async remove(name: string): Promise<void> {
    validateName(name);
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const destDir = join(this.baseDir, nameToPath(name));
    await rm(destDir, { recursive: true, force: true });
    this.agents.delete(name);
    this.events.publish({ type: "AgentUninstalled", name, at: new Date() });
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
      dependencies: [
        ...(agent.dependencies?.skills ?? []),
        ...(agent.dependencies?.mcps ?? []),
      ],
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

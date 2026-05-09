import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FrontmatterError, HasDependents, NotFound } from "../errors.js";
import {
  applyFrontmatterPatch,
  depRefToFqn,
  frontmatterToAgent,
  parseFrontmatter,
  projectionOpts,
} from "../frontmatter.js";
import type { GraphNode } from "../graph.js";
import type { AgentRepository, CatalogEntryFile } from "../repositories/repository.js";
import type { Agent, DependencyRef } from "../types.js";
import { validateFqn } from "../validate.js";

export type AgentMetadataPatch = Partial<{
  description: string;
  version: string;
  dependencies: { skills?: DependencyRef[]; mcps?: DependencyRef[] } | null;
}>;

/** Per-call options for {@link AgentCatalog.install}; see {@link InstallSkillOpts}. */
export interface InstallAgentOpts {
  readonly origin?: string;
}

/**
 * Business-logic facade over an {@link AgentRepository}.
 *
 * The Store owns frontmatter parsing, name validation, the in-memory cache,
 * and dependency-graph nodes. All catalog-internal IO is delegated to the
 * repository — the Store only touches user-provided source directories
 * directly (in `install()`).
 */
export class AgentCatalog {
  private readonly agents = new Map<string, Agent>();

  constructor(private readonly repository: AgentRepository) {}

  async install(sourceDir: string, opts: InstallAgentOpts = {}): Promise<Agent> {
    const sourcePath = join(sourceDir, "AGENTS.md");
    const original = await readFile(sourcePath, "utf8");
    const { data } = parseFrontmatter(original, sourcePath);
    const agent = frontmatterToAgent(data, sourcePath, projectionOpts(opts.origin));

    // See SkillCatalog.install for rationale: stage the dir copy first, then
    // inject `origin` into the catalog COPY only if the source omitted it.
    await this.repository.installFromDir(agent.name, sourceDir);
    if (data.origin === undefined) {
      const rewritten = applyFrontmatterPatch(original, { origin: agent.origin });
      await this.repository.write(agent.name, rewritten);
    }
    this.agents.set(agent.name, agent);
    return agent;
  }

  async getContent(name: string): Promise<string> {
    // Defense-in-depth: validate before going to the repo. Repos validate too,
    // but rejecting at the Store boundary keeps NotFound semantics for invalid
    // names rather than leaking a path-traversal error upstream.
    validateFqn(name);
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const content = await this.repository.read(name);
    if (content === null) throw new NotFound("agent", name);
    return content;
  }

  async updateContent(name: string, content: string): Promise<Agent> {
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const sourcePath = `repository:agents/${name}/AGENTS.md`;
    const { data } = parseFrontmatter(content, sourcePath);
    const existingAgent = this.agents.get(name);
    const agent = frontmatterToAgent(
      data,
      sourcePath,
      projectionOpts(existingAgent?.origin),
    );
    if (agent.name !== name) {
      throw new FrontmatterError(
        sourcePath,
        `cannot rename via edit: frontmatter resolves to "${agent.name}" but entry is "${name}". Remove and re-install instead.`,
      );
    }

    await this.repository.write(name, content);
    this.agents.set(name, agent);
    return agent;
  }

  async updateMetadata(name: string, patch: AgentMetadataPatch): Promise<Agent> {
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    const sourcePath = `repository:agents/${name}/AGENTS.md`;
    const existing = await this.repository.read(name);
    if (existing === null) throw new NotFound("agent", name);
    const existingAgent = this.agents.get(name);

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
          const obj: { skills?: readonly DependencyRef[]; mcps?: readonly DependencyRef[] } = {};
          if (skills.length > 0) obj.skills = skills;
          if (mcps.length > 0) obj.mcps = mcps;
          merge.dependencies = obj;
        }
      }
    }

    const newContent = applyFrontmatterPatch(existing, merge);
    const { data } = parseFrontmatter(newContent, sourcePath);
    const agent = frontmatterToAgent(
      data,
      sourcePath,
      projectionOpts(existingAgent?.origin),
    );
    if (agent.name !== name) {
      throw new FrontmatterError(
        sourcePath,
        `metadata patch must not change identity (current="${name}", patched="${agent.name}")`,
      );
    }

    await this.repository.write(name, newContent);
    this.agents.set(name, agent);
    return agent;
  }

  async remove(name: string, getDependents?: (name: string) => string[]): Promise<void> {
    validateFqn(name);
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
      dependencies: [
        ...(agent.dependencies?.skills ?? []).map(depRefToFqn),
        ...(agent.dependencies?.mcps ?? []).map(depRefToFqn),
      ],
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

  /** Stream every file of `name`. Throws NotFound if absent. */
  entries(name: string): AsyncIterable<CatalogEntryFile> {
    validateFqn(name);
    if (!this.agents.has(name)) throw new NotFound("agent", name);
    return this.repository.entries(name);
  }
}

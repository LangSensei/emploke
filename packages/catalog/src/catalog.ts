import { mkdir as mkdirFs, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplaceDir, atomicWriteJsonFile, pathExists } from "./atomic.js";
import {
  CatalogStateError,
  HasDependents,
  MissingDependencies,
  NameConflict,
  NotFound,
} from "./errors.js";
import { InMemoryEventBus } from "./event-bus.js";
import { frontmatterToAgent, frontmatterToSkill, parseFrontmatter } from "./frontmatter.js";
import { findDirectDependents, type GraphNode, resolveTopological } from "./graph.js";
import type {
  Agent,
  CatalogEvent,
  EventBus,
  ResolvedMcp,
  ResolvedSkill,
  ResolveResult,
  Skill,
} from "./types.js";
import { nameToPath, validateMcpName, validateName } from "./validate.js";

export interface ScanIssue {
  readonly path: string;
  readonly reason: string;
}

export interface CatalogOptions {
  readonly catalogDir: string;
}

/**
 * @emploke/catalog — manages agents, skills, and MCPs.
 *
 * Directory layout:
 *   <catalogDir>/skills/<name>/SKILL.md          (unscoped)
 *   <catalogDir>/skills/<scope>/<name>/SKILL.md  (scoped)
 *   <catalogDir>/agents/<name>/AGENTS.md         (unscoped)
 *   <catalogDir>/agents/<scope>/<name>/AGENTS.md (scoped)
 *   <catalogDir>/mcps/<name>.json                (no scope)
 */
export class Catalog {
  private readonly catalogDir: string;
  private readonly skills = new Map<string, Skill>();
  private readonly agents = new Map<string, Agent>();
  private readonly mcps = new Set<string>();
  private readonly _issues: ScanIssue[] = [];
  readonly events: EventBus<CatalogEvent> = new InMemoryEventBus<CatalogEvent>();

  private constructor(opts: CatalogOptions) {
    this.catalogDir = opts.catalogDir;
  }

  static async open(opts: CatalogOptions): Promise<Catalog> {
    const c = new Catalog(opts);
    await rmdir(join(opts.catalogDir, ".lock")).catch(() => {});
    await c.scan();
    return c;
  }

  get scanIssues(): readonly ScanIssue[] {
    return this._issues;
  }

  // ─── Skill ──────────────────────────────────────────────

  async installSkill(sourceDir: string): Promise<Skill> {
    const skillMd = join(sourceDir, "SKILL.md");
    const content = await readFile(skillMd, "utf8");
    const { data } = parseFrontmatter(content, skillMd);
    const skill = frontmatterToSkill(data, skillMd);
    validateName(skill.name);

    return this.withWriteLock(async () => {
      const destDir = join(this.catalogDir, "skills", nameToPath(skill.name));
      const exists = this.skills.has(skill.name);
      await atomicReplaceDir(sourceDir, destDir);
      this.skills.set(skill.name, skill);

      const event = {
        type: exists ? ("SkillUpdated" as const) : ("SkillInstalled" as const),
        name: skill.name,
        path: destDir,
        at: new Date(),
      };
      this.events.publish(event);
      return skill;
    });
  }

  async removeSkill(name: string): Promise<void> {
    validateName(name);
    return this.withWriteLock(async () => {
      if (!this.skills.has(name)) throw new NotFound("skill", name);

      // Check dependents across skills and agents
      const allDeps = this.allGraphNodes();
      const dependents = findDirectDependents(name, allDeps);
      if (dependents.length > 0) {
        throw new HasDependents(name, dependents.map((d) => d.name));
      }

      const destDir = join(this.catalogDir, "skills", nameToPath(name));
      await rm(destDir, { recursive: true, force: true });
      this.skills.delete(name);
      this.events.publish({ type: "SkillUninstalled", name, at: new Date() });
    });
  }

  getSkill(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  listSkills(): Skill[] {
    return [...this.skills.values()];
  }

  // ─── Agent ──────────────────────────────────────────────

  async installAgent(sourceDir: string): Promise<Agent> {
    const agentMd = join(sourceDir, "AGENTS.md");
    const content = await readFile(agentMd, "utf8");
    const { data } = parseFrontmatter(content, agentMd);
    const agent = frontmatterToAgent(data, agentMd);
    validateName(agent.name);

    return this.withWriteLock(async () => {
      const destDir = join(this.catalogDir, "agents", nameToPath(agent.name));
      const exists = this.agents.has(agent.name);
      await atomicReplaceDir(sourceDir, destDir);
      this.agents.set(agent.name, agent);

      const event = {
        type: exists ? ("AgentUpdated" as const) : ("AgentInstalled" as const),
        name: agent.name,
        path: destDir,
        at: new Date(),
      };
      this.events.publish(event);
      return agent;
    });
  }

  async removeAgent(name: string): Promise<void> {
    validateName(name);
    return this.withWriteLock(async () => {
      if (!this.agents.has(name)) throw new NotFound("agent", name);
      const destDir = join(this.catalogDir, "agents", nameToPath(name));
      await rm(destDir, { recursive: true, force: true });
      this.agents.delete(name);
      this.events.publish({ type: "AgentUninstalled", name, at: new Date() });
    });
  }

  getAgent(name: string): Agent | null {
    return this.agents.get(name) ?? null;
  }

  listAgents(): Agent[] {
    return [...this.agents.values()];
  }

  // ─── MCP ────────────────────────────────────────────────

  async installMcp(sourceFile: string, mcpName?: string): Promise<string> {
    const content = await readFile(sourceFile, "utf8");
    const parsed = JSON.parse(content);
    const name = mcpName ?? sourceFile.split("/").pop()!.replace(/\.json$/, "");
    validateMcpName(name);

    return this.withWriteLock(async () => {
      const destFile = join(this.catalogDir, "mcps", nameToPath(name) + ".json");
      const exists = this.mcps.has(name);
      const destDir = destFile.substring(0, destFile.lastIndexOf("/"));
      await mkdirFs(destDir, { recursive: true });
      await atomicWriteJsonFile(parsed, destFile);
      this.mcps.add(name);

      const event = {
        type: exists ? ("McpUpdated" as const) : ("McpInstalled" as const),
        name,
        path: destFile,
        at: new Date(),
      };
      this.events.publish(event);
      return name;
    });
  }

  async removeMcp(name: string): Promise<void> {
    validateMcpName(name);
    return this.withWriteLock(async () => {
      if (!this.mcps.has(name)) throw new NotFound("mcp", name);

      // Check dependents
      const allDeps = this.allGraphNodes();
      const dependents = findDirectDependents(name, allDeps);
      if (dependents.length > 0) {
        throw new HasDependents(name, dependents.map((d) => d.name));
      }

      const destFile = join(this.catalogDir, "mcps", nameToPath(name) + ".json");
      await rm(destFile, { force: true });
      this.mcps.delete(name);
      this.events.publish({ type: "McpUninstalled", name, at: new Date() });
    });
  }

  getMcpPath(name: string): string | null {
    if (!this.mcps.has(name)) return null;
    return join(this.catalogDir, "mcps", nameToPath(name) + ".json");
  }

  listMcps(): string[] {
    return [...this.mcps];
  }

  // ─── Resolution ─────────────────────────────────────────

  /**
   * Resolve all transitive dependencies for a skill or agent.
   * Returns skills in topological order + all referenced MCPs.
   */
  resolve(name: string): ResolveResult {
    // Build unified lookup for skills (agents are entry points, not deps)
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

    // Determine root dependencies
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
          path: join(this.catalogDir, "mcps", `${node.name}.json`),
        });
      }
    }

    return { skills, mcps };
  }

  // ─── Inspection ─────────────────────────────────────────

  /**
   * Parse an uninstalled source directory and return its metadata
   * without installing it into the catalog.
   */
  async inspectSource(sourceDir: string): Promise<Skill | Agent> {
    const skillPath = join(sourceDir, "SKILL.md");
    const agentPath = join(sourceDir, "AGENTS.md");

    if (await pathExists(skillPath)) {
      const content = await readFile(skillPath, "utf8");
      const { data } = parseFrontmatter(content, skillPath);
      return frontmatterToSkill(data, skillPath);
    }
    if (await pathExists(agentPath)) {
      const content = await readFile(agentPath, "utf8");
      const { data } = parseFrontmatter(content, agentPath);
      return frontmatterToAgent(data, agentPath);
    }
    throw new Error(`Source directory has neither SKILL.md nor AGENTS.md: ${sourceDir}`);
  }

  // ─── Internal ───────────────────────────────────────────

  private allGraphNodes(): GraphNode[] {
    const nodes: GraphNode[] = [];
    for (const [name, skill] of this.skills) {
      nodes.push({
        name,
        dependencies: [
          ...(skill.dependencies?.skills ?? []),
          ...(skill.dependencies?.mcps ?? []),
        ],
      });
    }
    for (const [name, agent] of this.agents) {
      nodes.push({
        name,
        dependencies: [
          ...(agent.dependencies?.skills ?? []),
          ...(agent.dependencies?.mcps ?? []),
        ],
      });
    }
    return nodes;
  }

  private async scan(): Promise<void> {
    this.skills.clear();
    this.agents.clear();
    this.mcps.clear();
    this._issues.length = 0;

    await this.scanSkills();
    await this.scanAgents();
    await this.scanMcps();
  }

  private async scanSkills(): Promise<void> {
    const skillsDir = join(this.catalogDir, "skills");
    if (!(await pathExists(skillsDir))) return;
    await this.scanSkillsDir(skillsDir, null);
  }

  /** Recursively scan skills directory (supports one level of scope). */
  private async scanSkillsDir(dir: string, scope: string | null): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(dir, entry.name);
      const skillMd = join(entryPath, "SKILL.md");

      if (await pathExists(skillMd)) {
        // This is a skill directory
        try {
          const content = await readFile(skillMd, "utf8");
          const { data } = parseFrontmatter(content, skillMd);
          const skill = frontmatterToSkill(data, skillMd);
          this.skills.set(skill.name, skill);
        } catch (e) {
          this._issues.push({ path: skillMd, reason: (e as Error).message });
        }
      } else if (scope === null) {
        // Maybe a scope directory — recurse one level
        await this.scanSkillsDir(entryPath, entry.name);
      }
    }
  }

  private async scanAgents(): Promise<void> {
    const agentsDir = join(this.catalogDir, "agents");
    if (!(await pathExists(agentsDir))) return;
    await this.scanAgentsDir(agentsDir, null);
  }

  private async scanAgentsDir(dir: string, scope: string | null): Promise<void> {
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
          this._issues.push({ path: agentMd, reason: (e as Error).message });
        }
      } else if (scope === null) {
        await this.scanAgentsDir(entryPath, entry.name);
      }
    }
  }

  private async scanMcps(): Promise<void> {
    const mcpsDir = join(this.catalogDir, "mcps");
    if (!(await pathExists(mcpsDir))) return;
    await this.scanMcpsDir(mcpsDir, null);
  }

  private async scanMcpsDir(dir: string, scope: string | null): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const baseName = entry.name.replace(/\.json$/, "");
        const fullName = scope ? `${scope}/${baseName}` : baseName;
        try {
          const content = await readFile(join(dir, entry.name), "utf8");
          JSON.parse(content);
          this.mcps.add(fullName);
        } catch (e) {
          this._issues.push({
            path: join(dir, entry.name),
            reason: (e as Error).message,
          });
        }
      } else if (entry.isDirectory() && scope === null) {
        // Scope directory
        await this.scanMcpsDir(join(dir, entry.name), entry.name);
      }
    }
  }

  // ─── Write Lock ─────────────────────────────────────────

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockDir = join(this.catalogDir, ".lock");
    const maxRetries = 50;
    const retryMs = 20;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await mkdirFs(lockDir);
        break;
      } catch (e: any) {
        if (e.code === "EEXIST") {
          if (i === maxRetries - 1) {
            throw new CatalogStateError("failed to acquire write lock (timeout)");
          }
          await new Promise((r) => setTimeout(r, retryMs));
        } else {
          throw e;
        }
      }
    }

    try {
      return await fn();
    } finally {
      await rmdir(lockDir).catch(() => {});
    }
  }
}

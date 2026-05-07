import { mkdir as mkdirFs, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentStore } from "./agent/agent-store.js";
import { pathExists } from "./atomic.js";
import { CatalogStateError } from "./errors.js";
import { InMemoryEventBus } from "./event-bus.js";
import { frontmatterToAgent, frontmatterToSkill, parseFrontmatter } from "./frontmatter.js";
import { findDirectDependents } from "./graph.js";
import { McpStore } from "./mcp/mcp-store.js";
import { Resolver } from "./resolver.js";
import { SkillStore } from "./skill/skill-store.js";
import type { Agent, CatalogEvent, EventBus, ResolveResult, Skill } from "./types.js";

export interface ScanIssue {
  readonly path: string;
  readonly reason: string;
}

export interface CatalogOptions {
  readonly catalogDir: string;
}

/**
 * Catalog — facade over SkillStore, AgentStore, McpStore, and Resolver.
 */
export class Catalog {
  private readonly catalogDir: string;
  private readonly skillStore: SkillStore;
  private readonly agentStore: AgentStore;
  private readonly mcpStore: McpStore;
  private readonly resolver: Resolver;
  private _issues: ScanIssue[] = [];
  readonly events: EventBus<CatalogEvent> = new InMemoryEventBus<CatalogEvent>();

  private constructor(opts: CatalogOptions) {
    this.catalogDir = opts.catalogDir;
    this.skillStore = new SkillStore(opts.catalogDir, this.events);
    this.agentStore = new AgentStore(opts.catalogDir, this.events);
    this.mcpStore = new McpStore(opts.catalogDir, this.events);
    this.resolver = new Resolver(this.skillStore, this.agentStore, this.mcpStore, opts.catalogDir);
  }

  static async open(opts: CatalogOptions): Promise<Catalog> {
    const c = new Catalog(opts);
    // Remove stale lock from previous crash. Safe under single-owner constraint.
    await rmdir(join(opts.catalogDir, ".lock")).catch(() => {});
    await c.scan();
    return c;
  }

  get scanIssues(): readonly ScanIssue[] {
    return this._issues;
  }

  // ─── Skill ──────────────────────────────────────────────

  async installSkill(sourceDir: string): Promise<Skill> {
    return this.withWriteLock(() => this.skillStore.install(sourceDir));
  }

  async removeSkill(name: string): Promise<void> {
    return this.withWriteLock(() => this.skillStore.remove(name, (n) => this.getDependents(n)));
  }

  getSkill(name: string): Skill | null {
    return this.skillStore.get(name);
  }

  listSkills(): Skill[] {
    return this.skillStore.list();
  }

  // ─── Agent ──────────────────────────────────────────────

  async installAgent(sourceDir: string): Promise<Agent> {
    return this.withWriteLock(() => this.agentStore.install(sourceDir));
  }

  async removeAgent(name: string): Promise<void> {
    return this.withWriteLock(() => this.agentStore.remove(name, (n) => this.getDependents(n)));
  }

  getAgent(name: string): Agent | null {
    return this.agentStore.get(name);
  }

  listAgents(): Agent[] {
    return this.agentStore.list();
  }

  // ─── MCP ────────────────────────────────────────────────

  async installMcp(sourceFile: string, mcpName?: string): Promise<string> {
    return this.withWriteLock(() => this.mcpStore.install(sourceFile, mcpName));
  }

  async removeMcp(name: string): Promise<void> {
    return this.withWriteLock(() => this.mcpStore.remove(name, (n) => this.getDependents(n)));
  }

  getMcpPath(name: string): string | null {
    return this.mcpStore.getPath(name);
  }

  listMcps(): string[] {
    return this.mcpStore.list();
  }

  // ─── Resolution ─────────────────────────────────────────

  resolve(name: string): ResolveResult {
    return this.resolver.resolve(name);
  }

  // ─── Rescan ──────────────────────────────────────────────

  async rescan(): Promise<void> {
    await this.scan();
  }

  // ─── Inspection ─────────────────────────────────────────

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

  private getDependents(name: string): string[] {
    const allNodes = [...this.skillStore.graphNodes(), ...this.agentStore.graphNodes()];
    return findDirectDependents(name, allNodes).map((d) => d.name);
  }

  private async scan(): Promise<void> {
    this._issues = [];
    const [skillIssues, agentIssues, mcpIssues] = await Promise.all([
      this.skillStore.scan(),
      this.agentStore.scan(),
      this.mcpStore.scan(),
    ]);
    this._issues = [...skillIssues, ...agentIssues, ...mcpIssues];
  }

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

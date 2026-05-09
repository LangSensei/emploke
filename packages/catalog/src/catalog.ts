import { mkdir as mkdirFs, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { type AgentMetadataPatch, AgentStore } from "./agent/agent-store.js";
import { pathExists } from "./atomic.js";
import { CatalogStateError } from "./errors.js";
import { frontmatterToAgent, frontmatterToSkill, parseFrontmatter } from "./frontmatter.js";
import { findDirectDependents } from "./graph.js";
import { McpStore } from "./mcp/mcp-store.js";
import { FsAgentRepository } from "./repositories/fs-agent-repository.js";
import { FsMcpRepository } from "./repositories/fs-mcp-repository.js";
import { FsSkillRepository } from "./repositories/fs-skill-repository.js";
import type { AgentRepository, McpRepository, SkillRepository } from "./repositories/repository.js";
import { Resolver } from "./resolver.js";
import { type SkillMetadataPatch, SkillStore } from "./skill/skill-store.js";
import type {
  Agent,
  AgentEntry,
  AgentResolveResult,
  MissingDep,
  Skill,
  SkillEntry,
  SkillResolveResult,
} from "./types.js";

export type { AgentMetadataPatch, SkillMetadataPatch };

export interface ScanIssue {
  readonly path: string;
  readonly reason: string;
}

export interface CatalogOptions {
  readonly catalogDir: string;
  /** Optional repository overrides (defaults to `Fs*Repository(catalogDir)`). */
  readonly repositories?: {
    readonly agents?: AgentRepository;
    readonly skills?: SkillRepository;
    readonly mcps?: McpRepository;
  };
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
  private _skillEntries = new Map<string, SkillEntry>();
  private _agentEntries = new Map<string, AgentEntry>();
  private _lastScanAt = 0;
  private _pendingScan: Promise<void> | null = null;

  private constructor(opts: CatalogOptions) {
    this.catalogDir = opts.catalogDir;
    const skillRepo = opts.repositories?.skills ?? new FsSkillRepository(opts.catalogDir);
    const agentRepo = opts.repositories?.agents ?? new FsAgentRepository(opts.catalogDir);
    const mcpRepo = opts.repositories?.mcps ?? new FsMcpRepository(opts.catalogDir);
    this.skillStore = new SkillStore(skillRepo);
    this.agentStore = new AgentStore(agentRepo);
    this.mcpStore = new McpStore(mcpRepo);
    this.resolver = new Resolver(this.skillStore, this.agentStore, this.mcpStore, opts.catalogDir);
  }

  static async open(opts: CatalogOptions): Promise<Catalog> {
    const c = new Catalog(opts);
    // Ensure catalog dir exists so subsequent writes (incl. .lock acquisition)
    // don't fail with ENOENT on a fresh install.
    await mkdirFs(opts.catalogDir, { recursive: true });
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
    const skill = await this.withWriteLock(() => this.skillStore.install(sourceDir));
    this.recomputeStatus();
    return skill;
  }

  async updateSkillContent(name: string, content: string): Promise<Skill> {
    const skill = await this.withWriteLock(() => this.skillStore.updateContent(name, content));
    this.recomputeStatus();
    return skill;
  }

  async updateSkillMetadata(name: string, patch: SkillMetadataPatch): Promise<Skill> {
    const skill = await this.withWriteLock(() => this.skillStore.updateMetadata(name, patch));
    this.recomputeStatus();
    return skill;
  }

  getSkillContent(name: string): Promise<string> {
    return this.skillStore.getContent(name);
  }

  async removeSkill(name: string): Promise<void> {
    await this.withWriteLock(() => this.skillStore.remove(name, (n) => this.getDependents(n)));
    this.recomputeStatus();
  }

  getSkill(name: string): Skill | null {
    return this.skillStore.get(name);
  }

  getSkillEntry(name: string): SkillEntry | null {
    return this._skillEntries.get(name) ?? null;
  }

  listSkills(): Skill[] {
    return this.skillStore.list();
  }

  listSkillEntries(): SkillEntry[] {
    return [...this._skillEntries.values()];
  }

  // ─── Agent ──────────────────────────────────────────────

  async installAgent(sourceDir: string): Promise<Agent> {
    const agent = await this.withWriteLock(() => this.agentStore.install(sourceDir));
    this.recomputeStatus();
    return agent;
  }

  async updateAgentContent(name: string, content: string): Promise<Agent> {
    const agent = await this.withWriteLock(() => this.agentStore.updateContent(name, content));
    this.recomputeStatus();
    return agent;
  }

  async updateAgentMetadata(name: string, patch: AgentMetadataPatch): Promise<Agent> {
    const agent = await this.withWriteLock(() => this.agentStore.updateMetadata(name, patch));
    this.recomputeStatus();
    return agent;
  }

  getAgentContent(name: string): Promise<string> {
    return this.agentStore.getContent(name);
  }

  async removeAgent(name: string): Promise<void> {
    await this.withWriteLock(() => this.agentStore.remove(name, (n) => this.getDependents(n)));
    this.recomputeStatus();
  }

  getAgent(name: string): Agent | null {
    return this.agentStore.get(name);
  }

  getAgentEntry(name: string): AgentEntry | null {
    return this._agentEntries.get(name) ?? null;
  }

  listAgents(): Agent[] {
    return this.agentStore.list();
  }

  listAgentEntries(): AgentEntry[] {
    return [...this._agentEntries.values()];
  }

  // ─── MCP ────────────────────────────────────────────────

  async installMcp(sourceFile: string, mcpName?: string): Promise<string> {
    const name = await this.withWriteLock(() => this.mcpStore.install(sourceFile, mcpName));
    this.recomputeStatus();
    return name;
  }

  async updateMcpContent(name: string, content: string): Promise<void> {
    await this.withWriteLock(() => this.mcpStore.updateContent(name, content));
    this.recomputeStatus();
  }

  getMcpContent(name: string): Promise<string> {
    return this.mcpStore.getContent(name);
  }

  async removeMcp(name: string): Promise<void> {
    await this.withWriteLock(() => this.mcpStore.remove(name, (n) => this.getDependents(n)));
    this.recomputeStatus();
  }

  getMcpPath(name: string): string | null {
    return this.mcpStore.getPath(name);
  }

  listMcps(): string[] {
    return this.mcpStore.list();
  }

  // ─── Resolution ─────────────────────────────────────────

  resolveAgent(name: string): AgentResolveResult {
    return this.resolver.resolveAgent(name);
  }

  resolveSkill(name: string): SkillResolveResult {
    return this.resolver.resolveSkill(name);
  }

  // ─── Rescan ──────────────────────────────────────────────

  async rescan(): Promise<void> {
    await this.scan();
  }

  /**
   * Re-scan the on-disk catalog if the in-memory state is older than
   * maxAgeMs. Throttle prevents back-to-back GETs (e.g. a dashboard mount
   * firing four parallel requests) from each triggering a full disk scan.
   *
   * Mutations always update memory synchronously, so this only catches
   * external writes (vim, git pull, third-party tools).
   */
  async rescanIfStale(maxAgeMs = 5_000): Promise<void> {
    if (Date.now() - this._lastScanAt <= maxAgeMs) return;
    // Single-flight: coalesce concurrent callers into one disk scan. Without
    // this, a dashboard mount that fires N parallel GETs would each pass the
    // staleness check and trigger N concurrent rescans.
    if (!this._pendingScan) {
      this._pendingScan = this.rescan().finally(() => {
        this._pendingScan = null;
      });
    }
    await this._pendingScan;
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
    this.recomputeStatus();
    this._lastScanAt = Date.now();
  }

  private recomputeStatus(): void {
    this._skillEntries.clear();
    this._agentEntries.clear();

    for (const skill of this.skillStore.list()) {
      const missing = this.findMissing(skill.dependencies);
      this._skillEntries.set(
        skill.name,
        missing.length > 0
          ? { skill, status: "disabled", missingDeps: missing }
          : { skill, status: "ready" },
      );
    }

    for (const agent of this.agentStore.list()) {
      const missing = this.findMissing(agent.dependencies);
      this._agentEntries.set(
        agent.name,
        missing.length > 0
          ? { agent, status: "disabled", missingDeps: missing }
          : { agent, status: "ready" },
      );
    }
  }

  private findMissing(dependencies?: {
    readonly skills?: readonly string[];
    readonly mcps?: readonly string[];
  }): MissingDep[] {
    if (!dependencies) return [];
    const missing: MissingDep[] = [];
    for (const s of dependencies.skills ?? []) {
      if (!this.skillStore.has(s)) missing.push({ kind: "skill", name: s });
    }
    for (const m of dependencies.mcps ?? []) {
      if (!this.mcpStore.has(m)) missing.push({ kind: "mcp", name: m });
    }
    return missing;
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockDir = join(this.catalogDir, ".lock");
    const maxRetries = 50;
    const retryMs = 20;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await mkdirFs(lockDir);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
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

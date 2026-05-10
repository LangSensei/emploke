import { mkdir as mkdirFs, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeOrigin, parseOrigin } from "@emploke/catalog-fetcher";
import { safeStat } from "@emploke/fs";
import { AgentCatalog, type AgentMetadataPatch } from "./agent/agent-catalog.js";
import { CatalogStateError, OriginConflictError } from "./errors.js";
import {
  depRefToFqn,
  frontmatterToAgent,
  frontmatterToSkill,
  type ProjectionOpts,
  parseFrontmatter,
  projectionOpts,
} from "./frontmatter.js";
import { findDirectDependents } from "./graph.js";
import { McpCatalog } from "./mcp/mcp-catalog.js";
import { FsAgentRepository } from "./repositories/fs-agent-repository.js";
import { FsMcpRepository } from "./repositories/fs-mcp-repository.js";
import { FsSkillRepository } from "./repositories/fs-skill-repository.js";
import type {
  AgentRepository,
  CatalogEntryFile,
  McpRepository,
  SkillRepository,
} from "./repositories/repository.js";
import { Resolver } from "./resolver.js";
import { SkillCatalog, type SkillMetadataPatch } from "./skill/skill-catalog.js";
import type {
  Agent,
  AgentEntry,
  AgentResolveResult,
  DependencyRef,
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
 * Per-call options for `installSkill` / `installAgent`.
 *
 * `origin` is the URI to associate with the new entry (recorded in the
 * catalog's frontmatter copy if the source omits one). Routes pass the
 * URI the user supplied; the per-store install impls synthesise
 * `file:<sourcePath>` if neither this nor the frontmatter has it.
 *
 * No `scopeOverride`: scope is determined entirely by the entry's
 * frontmatter (`scope: <name>` or default `public`). Forking under a
 * different scope means editing the upstream's frontmatter, not
 * passing a per-install flag — see `frontmatter.ts` for rationale.
 */
export interface InstallEntryOpts {
  readonly origin?: string;
}

/**
 * Per-call options for `installMcp`. Both fields are required:
 *  - `name` — full MCP-spec FQN (`<namespace>/<short>`, e.g. `azure/mcp`)
 *  - `origin` — install-source URI (recorded in `_meta.origin`)
 *
 * MCPs do NOT participate in scope-mapping; the spec name IS the
 * catalog identity, no derivation, no override.
 */
export interface InstallMcpOpts {
  readonly name: string;
  readonly origin: string;
}

/**
 * Catalog — facade over SkillCatalog, AgentCatalog, McpCatalog, and Resolver.
 * Holds the catalog write-lock; scope is purely frontmatter-driven (no
 * external resolver / mapping table).
 */
export class CatalogManager {
  private readonly catalogDir: string;
  private readonly skillStore: SkillCatalog;
  private readonly agentStore: AgentCatalog;
  private readonly mcpStore: McpCatalog;
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
    this.skillStore = new SkillCatalog(skillRepo);
    this.agentStore = new AgentCatalog(agentRepo);
    this.mcpStore = new McpCatalog(mcpRepo);
    this.resolver = new Resolver(this.skillStore, this.agentStore, this.mcpStore);
  }

  static async open(opts: CatalogOptions): Promise<CatalogManager> {
    await mkdirFs(opts.catalogDir, { recursive: true });
    const c = new CatalogManager(opts);
    // Remove stale lock from previous crash. Safe under single-owner constraint.
    await rmdir(join(opts.catalogDir, ".lock")).catch(() => {});
    await c.scan();
    return c;
  }

  get scanIssues(): readonly ScanIssue[] {
    return this._issues;
  }

  // ─── Skill ──────────────────────────────────────────────

  async installSkill(sourceDir: string, opts: InstallEntryOpts = {}): Promise<Skill> {
    const projOpts = projectionOpts(opts.origin);
    const skill = await this.withWriteLock(async () => {
      // Pre-flight origin-conflict check: parse the would-be FQN+origin
      // before doing any IO so a conflict fails fast and predictably.
      await this.assertNoOriginConflict("skill", sourceDir, "SKILL.md", projOpts);
      return this.skillStore.install(sourceDir, opts);
    });
    this.recomputeStatus();
    return skill;
  }

  /**
   * Stream-based install used by the pluggable-fetcher route. Buffers the
   * stream once (skill payloads are tiny), parses SKILL.md to compute the
   * FQN, runs the same origin-conflict pre-flight as `installSkill`, then
   * forwards to the repository's stream-install.
   */
  async installSkillFromStream(
    stream: AsyncIterable<CatalogEntryFile>,
    opts: InstallEntryOpts = {},
    sourceLabel?: string,
  ): Promise<Skill> {
    const buffered = await bufferStream(stream);
    const projOpts = projectionOpts(opts.origin);
    await this.assertNoOriginConflictFromBuffer(
      "skill",
      buffered,
      "SKILL.md",
      sourceLabel ?? "<stream>",
      projOpts,
    );
    const skill = await this.withWriteLock(() =>
      this.skillStore.installFromStream(asyncIterableOf(buffered), opts, sourceLabel),
    );
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

  async installAgent(sourceDir: string, opts: InstallEntryOpts = {}): Promise<Agent> {
    const projOpts = projectionOpts(opts.origin);
    const agent = await this.withWriteLock(async () => {
      await this.assertNoOriginConflict("agent", sourceDir, "AGENTS.md", projOpts);
      return this.agentStore.install(sourceDir, opts);
    });
    this.recomputeStatus();
    return agent;
  }

  /** Stream-based install. See {@link installSkillFromStream}. */
  async installAgentFromStream(
    stream: AsyncIterable<CatalogEntryFile>,
    opts: InstallEntryOpts = {},
    sourceLabel?: string,
  ): Promise<Agent> {
    const buffered = await bufferStream(stream);
    const projOpts = projectionOpts(opts.origin);
    await this.assertNoOriginConflictFromBuffer(
      "agent",
      buffered,
      "AGENTS.md",
      sourceLabel ?? "<stream>",
      projOpts,
    );
    const agent = await this.withWriteLock(() =>
      this.agentStore.installFromStream(asyncIterableOf(buffered), opts, sourceLabel),
    );
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

  /**
   * Install an MCP from raw JSON content. The spec name (`opts.name`,
   * with `/`) IS the catalog identity — no scope-mapping, no derivation.
   * The caller (route layer) is expected to have validated `opts.name`
   * via {@link validateMcpName} already; this method validates again
   * defensively.
   */
  async installMcp(content: string, opts: InstallMcpOpts): Promise<string> {
    const fqn = await this.withWriteLock(async () => {
      const existing = this.mcpStore.get(opts.name);
      if (existing) {
        const a = normalizeOrigin(parseOrigin(existing.origin));
        const b = normalizeOrigin(parseOrigin(opts.origin));
        if (a !== b) {
          throw new OriginConflictError(opts.name, existing.origin, opts.origin);
        }
      }
      return this.mcpStore.installFromContent(content, opts);
    });
    this.recomputeStatus();
    return fqn;
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

  listMcps(): string[] {
    return this.mcpStore.list();
  }

  /** Look up the full metadata record for an installed MCP. */
  getMcp(name: string) {
    return this.mcpStore.get(name);
  }

  // ─── Entry-content streams ──────────────────────────────
  //
  // Stream the files of a skill or agent without exposing on-disk paths.
  // The runtime uses these to bake catalog entries into a session workdir.
  // FS-backed and SQLite-backed repositories implement the same surface,
  // so the runtime never has to know which is in play.

  /** Stream every file of the named skill (incl. SKILL.md). */
  skillEntries(name: string): AsyncIterable<CatalogEntryFile> {
    return this.skillStore.entries(name);
  }

  /** Stream every file of the named agent (incl. AGENTS.md). */
  agentEntries(name: string): AsyncIterable<CatalogEntryFile> {
    return this.agentStore.entries(name);
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

  async inspectSource(sourceDir: string, opts: InstallEntryOpts = {}): Promise<Skill | Agent> {
    const skillPath = join(sourceDir, "SKILL.md");
    const agentPath = join(sourceDir, "AGENTS.md");
    const projOpts = projectionOpts(opts.origin);

    if ((await safeStat(skillPath)) !== null) {
      const content = await readFile(skillPath, "utf8");
      const { data } = parseFrontmatter(content, skillPath);
      return frontmatterToSkill(data, skillPath, projOpts);
    }
    if ((await safeStat(agentPath)) !== null) {
      const content = await readFile(agentPath, "utf8");
      const { data } = parseFrontmatter(content, agentPath);
      return frontmatterToAgent(data, agentPath, projOpts);
    }
    throw new Error(`Source directory has neither SKILL.md nor AGENTS.md: ${sourceDir}`);
  }

  // ─── Internal ───────────────────────────────────────────

  private getDependents(name: string): string[] {
    const allNodes = [...this.skillStore.graphNodes(), ...this.agentStore.graphNodes()];
    return findDirectDependents(name, allNodes).map((d) => d.name);
  }

  /**
   * Pre-flight check: parse the source frontmatter, project to FQN, and
   * compare origins against any existing entry under the same FQN.
   * Throws {@link OriginConflictError} on mismatch (post-#39 catalog
   * identity rule: same FQN must always resolve to the same upstream).
   */
  private async assertNoOriginConflict(
    kind: "skill" | "agent",
    sourceDir: string,
    fileName: string,
    projOpts: ProjectionOpts,
  ): Promise<void> {
    const sourcePath = join(sourceDir, fileName);
    const content = await readFile(sourcePath, "utf8");
    const { data } = parseFrontmatter(content, sourcePath);
    const incoming =
      kind === "skill"
        ? frontmatterToSkill(data, sourcePath, projOpts)
        : frontmatterToAgent(data, sourcePath, projOpts);

    const existing =
      kind === "skill" ? this.skillStore.get(incoming.name) : this.agentStore.get(incoming.name);
    if (!existing) return;

    const a = normalizeOrigin(parseOrigin(existing.origin));
    const b = normalizeOrigin(parseOrigin(incoming.origin));
    if (a !== b) throw new OriginConflictError(incoming.name, existing.origin, incoming.origin);
  }

  /** Stream-based variant of {@link assertNoOriginConflict}. */
  private async assertNoOriginConflictFromBuffer(
    kind: "skill" | "agent",
    buffered: readonly CatalogEntryFile[],
    fileName: string,
    sourceLabel: string,
    projOpts: ProjectionOpts,
  ): Promise<void> {
    const anchor = buffered.find((f) => f.relPath === fileName);
    if (!anchor) {
      throw new Error(`stream did not contain a top-level ${fileName} (source: ${sourceLabel})`);
    }
    const sourcePath = `${sourceLabel}/${fileName}`;
    const content = anchor.content.toString("utf8");
    const { data } = parseFrontmatter(content, sourcePath);
    const incoming =
      kind === "skill"
        ? frontmatterToSkill(data, sourcePath, projOpts)
        : frontmatterToAgent(data, sourcePath, projOpts);

    const existing =
      kind === "skill" ? this.skillStore.get(incoming.name) : this.agentStore.get(incoming.name);
    if (!existing) return;

    const a = normalizeOrigin(parseOrigin(existing.origin));
    const b = normalizeOrigin(parseOrigin(incoming.origin));
    if (a !== b) throw new OriginConflictError(incoming.name, existing.origin, incoming.origin);
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
    readonly skills?: readonly DependencyRef[];
    readonly mcps?: readonly DependencyRef[];
  }): MissingDep[] {
    if (!dependencies) return [];
    const missing: MissingDep[] = [];
    for (const ref of dependencies.skills ?? []) {
      const fqn = depRefToFqn(ref, "skill");
      if (!this.skillStore.has(fqn)) missing.push({ kind: "skill", name: fqn });
    }
    for (const ref of dependencies.mcps ?? []) {
      const fqn = depRefToFqn(ref, "mcp");
      if (!this.mcpStore.has(fqn)) missing.push({ kind: "mcp", name: fqn });
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

async function bufferStream(stream: AsyncIterable<CatalogEntryFile>): Promise<CatalogEntryFile[]> {
  const out: CatalogEntryFile[] = [];
  for await (const file of stream) out.push(file);
  return out;
}

async function* asyncIterableOf<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}

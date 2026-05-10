import { mkdir as mkdirFs, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultFetcherRegistry,
  type EntryFile,
  type FetcherRegistry,
  normalizeOrigin,
  parseOrigin,
} from "@emploke/catalog-fetcher";
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
  /**
   * Optional fetcher registry override. Defaults to
   * {@link defaultFetcherRegistry} (file: + github:). Tests inject a
   * fake registry whose fetchers yield from in-memory fixtures.
   */
  readonly fetchers?: FetcherRegistry;
  /** Optional repository overrides (defaults to `Fs*Repository(catalogDir)`). */
  readonly repositories?: {
    readonly agents?: AgentRepository;
    readonly skills?: SkillRepository;
    readonly mcps?: McpRepository;
  };
}

/**
 * Per-call options for the install* methods.
 *
 * `origin` is the URI to associate with the new entry (recorded in the
 * catalog's frontmatter copy if the source omits one). Routes pass the
 * URI the user supplied.
 *
 * No `scopeOverride`: scope is determined entirely by the entry's
 * frontmatter (`scope: <name>` or default `public`). Forking under a
 * different scope means editing the upstream's frontmatter, not
 * passing a per-install flag.
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
 * catalog identity.
 */
export interface InstallMcpOpts {
  readonly name: string;
  readonly origin: string;
}

/**
 * Catalog — facade over SkillCatalog, AgentCatalog, McpCatalog, and Resolver.
 * Holds the catalog write-lock + the FetcherRegistry; scope is purely
 * frontmatter-driven (no external resolver / mapping table).
 *
 * Two install-method shapes per kind:
 *  - `installSkill(stream, opts)` — low-level, takes an EntryFile stream
 *    (used internally by `applyInstall` after the fetcher has produced
 *    a stream).
 *  - `installSkillFromOrigin(origin)` — high-level, dispatches the
 *    fetcher itself. Routes / CLI use this directly.
 */
export class CatalogManager {
  private readonly catalogDir: string;
  private readonly skillStore: SkillCatalog;
  private readonly agentStore: AgentCatalog;
  private readonly mcpStore: McpCatalog;
  private readonly resolver: Resolver;
  private readonly fetcherRegistry: FetcherRegistry;
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
    this.fetcherRegistry = opts.fetchers ?? defaultFetcherRegistry();
    this.skillStore = new SkillCatalog(skillRepo);
    this.agentStore = new AgentCatalog(agentRepo);
    this.mcpStore = new McpCatalog(mcpRepo);
    this.resolver = new Resolver(this.skillStore, this.agentStore, this.mcpStore);
  }

  static async open(opts: CatalogOptions): Promise<CatalogManager> {
    await mkdirFs(opts.catalogDir, { recursive: true });
    const c = new CatalogManager(opts);
    // Boot cleanup:
    //  - .lock: stale lock from a previous crash (safe under single-owner)
    //  - .tmp:  in-progress install scratch from a crashed/killed process.
    //           Anything still here means the install never reached the
    //           atomic-rename step; we throw it away and the user can
    //           re-trigger the install.
    await Promise.all([
      rmdir(join(opts.catalogDir, ".lock")).catch(() => {}),
      rm(join(opts.catalogDir, ".tmp"), { recursive: true, force: true }).catch(() => {}),
    ]);
    await c.scan();
    return c;
  }

  /** The FetcherRegistry this catalog uses. Used by `resolveInstall`/`applyInstall`. */
  get fetchers(): FetcherRegistry {
    return this.fetcherRegistry;
  }

  get scanIssues(): readonly ScanIssue[] {
    return this._issues;
  }

  // ─── Skill ──────────────────────────────────────────────

  /**
   * Install a skill from an `EntryFile` stream (low-level). Buffers the
   * stream, parses SKILL.md to derive the FQN, runs the origin-conflict
   * pre-flight, then forwards to the repository's stream-install.
   *
   * Most callers want {@link installSkillFromOrigin} instead, which
   * handles the fetcher dispatch.
   */
  async installSkill(
    stream: AsyncIterable<CatalogEntryFile>,
    opts: InstallEntryOpts = {},
    sourceLabel?: string,
  ): Promise<Skill> {
    const buffered = await bufferStream(stream);
    const projOpts = projectionOpts(opts.origin);
    await this.assertNoOriginConflict(
      "skill",
      buffered,
      "SKILL.md",
      sourceLabel ?? "<stream>",
      projOpts,
    );
    const skill = await this.withWriteLock(() =>
      this.skillStore.install(asyncIterableOf(buffered), opts, sourceLabel),
    );
    this.recomputeStatus();
    return skill;
  }

  /**
   * Install a skill by `origin` URI — fetches via the registered fetcher
   * (file:, https://github.com/...) and installs. The most direct API for
   * single-shot installs (CLI, route convenience).
   *
   * For recursive installs (fetch the root + walk its dep graph), use
   * `resolveInstall` + `applyInstall` from the catalog package.
   */
  async installSkillFromOrigin(origin: string, opts: InstallEntryOpts = {}): Promise<Skill> {
    const stream = this.fetcherRegistry.dispatch(origin);
    return this.installSkill(stream, { ...opts, origin: opts.origin ?? origin }, origin);
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

  /** Install an agent from an `EntryFile` stream. See {@link installSkill}. */
  async installAgent(
    stream: AsyncIterable<CatalogEntryFile>,
    opts: InstallEntryOpts = {},
    sourceLabel?: string,
  ): Promise<Agent> {
    const buffered = await bufferStream(stream);
    const projOpts = projectionOpts(opts.origin);
    await this.assertNoOriginConflict(
      "agent",
      buffered,
      "AGENTS.md",
      sourceLabel ?? "<stream>",
      projOpts,
    );
    const agent = await this.withWriteLock(() =>
      this.agentStore.install(asyncIterableOf(buffered), opts, sourceLabel),
    );
    this.recomputeStatus();
    return agent;
  }

  /** Install an agent by `origin` URI. See {@link installSkillFromOrigin}. */
  async installAgentFromOrigin(origin: string, opts: InstallEntryOpts = {}): Promise<Agent> {
    const stream = this.fetcherRegistry.dispatch(origin);
    return this.installAgent(stream, { ...opts, origin: opts.origin ?? origin }, origin);
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
      return this.mcpStore.install(content, opts);
    });
    this.recomputeStatus();
    return fqn;
  }

  /**
   * Install an MCP by `origin` URI. Fetches via the registered fetcher,
   * reads the (single) JSON file, and installs under `opts.name` (the
   * MCP-spec FQN).
   */
  async installMcpFromOrigin(origin: string, name: string): Promise<string> {
    const stream = this.fetcherRegistry.dispatch(origin);
    const content = await readSingleFile(stream);
    return this.installMcp(content, { name, origin });
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

  // ─── Internal ───────────────────────────────────────────

  private getDependents(name: string): string[] {
    const allNodes = [...this.skillStore.graphNodes(), ...this.agentStore.graphNodes()];
    return findDirectDependents(name, allNodes).map((d) => d.name);
  }

  /**
   * Pre-flight check: parse the source frontmatter, project to FQN, and
   * compare origins against any existing entry under the same FQN.
   * Throws {@link OriginConflictError} on mismatch (catalog identity
   * rule: same FQN must always resolve to the same upstream).
   */
  private async assertNoOriginConflict(
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

async function readSingleFile(stream: AsyncIterable<EntryFile>): Promise<string> {
  let result: Buffer | null = null;
  for await (const file of stream) {
    if (result === null) result = file.content;
  }
  if (result === null) throw new Error("stream yielded no files (expected one for mcp install)");
  return result.toString("utf8");
}

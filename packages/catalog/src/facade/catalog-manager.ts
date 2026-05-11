import { join } from "node:path";
import {
  defaultFetcherRegistry,
  type EntryFile,
  type FetcherRegistry,
} from "@emploke/catalog-fetcher";
import { type Logger, silentLogger } from "@emploke/logger";
import type { Agent } from "../agent/agent-entity.js";
import { type AgentResolvedNode, AgentService } from "../agent/agent-service.js";
import { AgentNotFoundError } from "../agent/errors.js";
import { SqliteAgentRepository } from "../agent/sqlite-agent-repository.js";
import type {
  AgentEntry,
  AgentMetadataPatch,
  Agent as AgentPojo,
  AgentResolveResult,
  EntryStatus,
  InstallEntryOpts,
  InstallMcpOpts,
  McpMetadata,
  MissingDep,
  ResolvedMcp,
  ResolvedSkill,
  ScanIssue,
  SkillEntry,
  SkillMetadataPatch,
  Skill as SkillPojo,
  SkillResolveResult,
} from "../compat/types.js";
import { McpNotFoundError } from "../mcp/errors.js";
import { Mcp } from "../mcp/mcp-entity.js";
import * as McpFormat from "../mcp/mcp-format.js";
import { type McpFetcher, McpService } from "../mcp/mcp-service.js";
import { SqliteMcpRepository } from "../mcp/sqlite-mcp-repository.js";
import { isOriginMutable } from "../origin-mutability.js";
import { SkillNotFoundError } from "../skill/errors.js";
import type { Skill } from "../skill/skill-entity.js";
import { type SkillFetcher, type SkillResolvedNode, SkillService } from "../skill/skill-service.js";
import { SqliteSkillRepository } from "../skill/sqlite-skill-repository.js";
import { HasDependentsError } from "./errors.js";

/**
 * Catalog facade: cross-entity orchestration over the per-entity
 * services (Mcp / Skill / Agent).
 *
 * Two API surfaces, both stable:
 *
 * 1. **New install/resolve flow** — `resolveSkill` / `resolveAgent` /
 *    `resolveMcp` return a `CatalogPlan` (cross-entity DAG); `install`
 *    consumes a plan or origin string and walks the topology.
 *
 * 2. **Legacy consumer-facing API** — `listSkillEntries`,
 *    `getSkillContent`, `agentEntries`, etc. mirror the pre-refactor
 *    `CatalogManager`.
 *
 * Identity vocabulary recap:
 *   - skill / agent: `fqn` (`<scope>/<shortName>`) is the local
 *     namespace key; `origin` is the install-source URI.
 *   - mcp: `name` (`<namespace>/<short>`) is the spec FQN; emploke
 *     uses it as the local key without an extra scope segment.
 */

// ─── Plan shape ─────────────────────────────────────────────

export type CatalogPlanNode =
  | { kind: "mcp"; node: McpResolvedNode; wasAlreadyInstalled?: boolean }
  | { kind: "skill"; node: SkillResolvedNode; wasAlreadyInstalled?: boolean }
  | { kind: "agent"; node: AgentResolvedNode; wasAlreadyInstalled?: boolean };

export interface McpResolvedNode {
  /** MCP spec FQN (mcps don't have a separate `fqn` concept; name IS fqn). */
  readonly fqn: string;
  readonly origin: string;
  readonly content: string;
}

export type CatalogConflict = {
  readonly kind: "mcp" | "skill" | "agent";
  readonly origin: string;
  readonly fqn: string | null;
  readonly reason:
    | { kind: "fetch-failed"; cause: unknown }
    | { kind: "parse-failed"; cause: unknown }
    | { kind: "origin-conflict"; existingOrigin: string };
};

export interface CatalogPlan {
  readonly toInstall: readonly CatalogPlanNode[];
  readonly alreadyInstalled: readonly CatalogPlanNode[];
  readonly conflicts: readonly CatalogConflict[];
}

export interface CatalogInstallResult {
  readonly installed: readonly { kind: "mcp" | "skill" | "agent"; fqn: string }[];
  readonly skipped: readonly {
    kind: "mcp" | "skill" | "agent";
    fqn: string;
    reason: "already-installed" | "dep-failed";
  }[];
  readonly failed: readonly {
    kind: "mcp" | "skill" | "agent";
    fqn: string;
    error: Error;
  }[];
}

export interface CatalogOptions {
  readonly catalogDir: string;
  readonly fetchers?: FetcherRegistry;
  /**
   * Optional logger. Threaded into each per-entity repository so
   * structured warnings (skipped corrupt rows, future scan issues)
   * land in the same log stream as the rest of the server. Defaults
   * to {@link silentLogger} when omitted — the right choice for
   * unit tests and short-lived CLIs.
   */
  readonly logger?: Logger;
}

export type McpResolveAdapter = (origin: string) => Promise<{
  node: McpResolvedNode | null;
  conflict: CatalogConflict | null;
}>;

export class CatalogManager {
  scanIssues: ScanIssue[] = [];

  constructor(
    private readonly mcp: McpService,
    private readonly skill: SkillService,
    private readonly agent: AgentService,
    /**
     * Adapter for resolving an MCP from an origin without persisting.
     * The adapter fetches + parses the JSON to derive the spec FQN
     * (`_meta.name`) — the facade can't ask the user for the name
     * since dep refs are origin-only.
     */
    private readonly resolveMcpAdapter: McpResolveAdapter,
  ) {}

  /**
   * Open a SQLite-backed catalog rooted at `catalogDir`. Creates the
   * database file (`catalog.db`) inside that directory if missing.
   */
  static async open(opts: CatalogOptions): Promise<CatalogManager> {
    const fetchers = opts.fetchers ?? defaultFetcherRegistry();
    const logger = opts.logger ?? silentLogger;
    const dbPath = join(opts.catalogDir, "catalog.db");

    const mcpRepo = new SqliteMcpRepository(dbPath, { logger });
    const skillRepo = new SqliteSkillRepository(dbPath, { logger });
    const agentRepo = new SqliteAgentRepository(dbPath, { logger });

    const mcpFetcher: McpFetcher = (origin) => fetchers.dispatch(origin);
    const skillFetcher: SkillFetcher = {
      async fetchAnchor(origin) {
        return readFirstFile(fetchers.dispatch(origin), "SKILL.md");
      },
      fetchTree(origin) {
        return fetchers.dispatch(origin);
      },
    };
    const agentFetcher = {
      async fetchAnchor(origin: string) {
        return readFirstFile(fetchers.dispatch(origin), "AGENTS.md");
      },
      fetchTree(origin: string) {
        return fetchers.dispatch(origin);
      },
    };

    const mcpSvc = new McpService(mcpRepo, mcpFetcher);
    const skillSvc = new SkillService(skillRepo, skillFetcher);
    const agentSvc = new AgentService(agentRepo, agentFetcher);

    const resolveMcp: McpResolveAdapter = async (origin) => {
      try {
        const content = await readFirstFile(fetchers.dispatch(origin), null);
        // Parse the existing _meta to recover the spec FQN. Authors
        // declare MCPs by origin in dep refs; we derive name from the
        // anchor's _meta.name field.
        const parsed = McpFormat.parse(content, `resolve:${origin}`);
        const name = parsed.meta.name;
        // Re-inject our origin in case the upstream had a stale value.
        const merged = McpFormat.writeMeta(content, { name, origin }, `resolve:${origin}`);
        return { node: { fqn: name, origin, content: merged }, conflict: null };
      } catch (cause) {
        return {
          node: null,
          conflict: {
            kind: "mcp",
            origin,
            fqn: null,
            reason: { kind: "fetch-failed", cause },
          },
        };
      }
    };

    const mgr = new CatalogManager(mcpSvc, skillSvc, agentSvc, resolveMcp);
    await mgr.refresh();
    return mgr;
  }

  // ─── Lifecycle ────────────────────────────────────────

  close(): void {
    this.skill.close();
    this.agent.close();
    this.mcp.close();
  }

  // ─── Resolve (cross-entity walk) ──────────────────────

  async resolveSkill(origin: string): Promise<CatalogPlan> {
    const ctx = newResolveContext();
    await this.walkSkill(origin, ctx, true);
    return finaliseResolveContext(ctx);
  }

  async resolveAgentFromOrigin(origin: string): Promise<CatalogPlan> {
    const ctx = newResolveContext();
    await this.walkAgent(origin, ctx);
    return finaliseResolveContext(ctx);
  }

  async resolveMcp(origin: string): Promise<CatalogPlan> {
    const ctx = newResolveContext();
    await this.walkMcp(origin, ctx, true);
    return finaliseResolveContext(ctx);
  }

  // ─── Install ──────────────────────────────────────────

  async install(plan: CatalogPlan): Promise<CatalogInstallResult> {
    const installed: { kind: "mcp" | "skill" | "agent"; fqn: string }[] = [];
    const failed: { kind: "mcp" | "skill" | "agent"; fqn: string; error: Error }[] = [];
    const skipped: {
      kind: "mcp" | "skill" | "agent";
      fqn: string;
      reason: "already-installed" | "dep-failed";
    }[] = plan.alreadyInstalled.map((n) => ({
      kind: n.kind,
      fqn: n.node.fqn,
      reason: "already-installed" as const,
    }));

    const poisoned = new Set<string>(); // keyed by origin
    const depsByOrigin = new Map<string, string[]>();
    for (const planNode of plan.toInstall) {
      depsByOrigin.set(planNode.node.origin, planRefs(planNode));
    }

    for (const planNode of plan.toInstall) {
      const fqn = planNode.node.fqn;
      const origin = planNode.node.origin;
      const failedDep = (depsByOrigin.get(origin) ?? []).find((dep) => poisoned.has(dep));
      if (failedDep !== undefined) {
        skipped.push({ kind: planNode.kind, fqn, reason: "dep-failed" });
        poisoned.add(origin);
        continue;
      }
      try {
        await this.installNode(planNode);
        installed.push({ kind: planNode.kind, fqn });
      } catch (err) {
        failed.push({ kind: planNode.kind, fqn, error: err as Error });
        poisoned.add(origin);
      }
    }

    if (installed.length > 0) await this.refresh();
    return { installed, skipped, failed };
  }

  // ─── Single-shot installer convenience ────────────────

  async installSkill(origin: string): Promise<CatalogInstallResult> {
    return this.install(await this.resolveSkill(origin));
  }

  async installAgent(origin: string): Promise<CatalogInstallResult> {
    return this.install(await this.resolveAgentFromOrigin(origin));
  }

  // ─── Legacy consumer API (backward-compat shims) ───

  async installSkillFromOrigin(origin: string, _opts: InstallEntryOpts = {}): Promise<SkillPojo> {
    const plan = await this.resolveSkill(origin);
    const result = await this.install(plan);
    if (plan.conflicts.length > 0 && plan.toInstall.length === 0) {
      throw conflictToError(plan.conflicts[0] as CatalogConflict);
    }
    if (result.failed.length > 0) throw result.failed[0]!.error;
    const installed = await this.skill.getByOrigin(origin);
    if (installed === null) {
      throw new Error(`installSkillFromOrigin: no entity persisted for ${origin}`);
    }
    await this.refresh();
    return installed.toJSON() as unknown as SkillPojo;
  }

  async installAgentFromOrigin(origin: string, _opts: InstallEntryOpts = {}): Promise<AgentPojo> {
    const plan = await this.resolveAgentFromOrigin(origin);
    const result = await this.install(plan);
    if (plan.conflicts.length > 0 && plan.toInstall.length === 0) {
      throw conflictToError(plan.conflicts[0] as CatalogConflict);
    }
    if (result.failed.length > 0) throw result.failed[0]!.error;
    const installed = await this.agent.getByOrigin(origin);
    if (installed === null) {
      throw new Error(`installAgentFromOrigin: no entity persisted for ${origin}`);
    }
    await this.refresh();
    return installed.toJSON() as unknown as AgentPojo;
  }

  async installMcp(content: string, opts: InstallMcpOpts): Promise<string> {
    const entity = await this.mcp.install(opts.name, opts.origin, content);
    await this.refresh();
    return entity.name;
  }

  /**
   * Install an MCP by origin. The MCP's spec FQN is recovered from the
   * fetched JSON's `_meta.name` field at resolve time — clients don't
   * need to specify a name up front.
   */
  async installMcpFromOrigin(origin: string): Promise<CatalogInstallResult> {
    return this.install(await this.resolveMcp(origin));
  }

  // ─── Reads ────────────────────────────────────────────

  listSkillEntries(): SkillEntry[] {
    const skills = this._skillsCache;
    const installedMcps = new Set(this._mcpsCache.map((m) => m.name));
    const installedSkillOrigins = new Set(this._skillsCache.map((s) => s.origin));
    const out: SkillEntry[] = [];
    for (const s of skills) {
      const { status, missingDeps } = computeStatus(
        s.dependencies,
        installedSkillOrigins,
        installedMcps,
        this._mcpsCache.map((m) => m.origin),
      );
      out.push(buildSkillEntry(s, status, missingDeps));
    }
    return out;
  }

  listAgentEntries(): AgentEntry[] {
    const agents = this._agentsCache;
    const installedMcps = new Set(this._mcpsCache.map((m) => m.name));
    const installedSkillOrigins = new Set(this._skillsCache.map((s) => s.origin));
    const out: AgentEntry[] = [];
    for (const a of agents) {
      const { status, missingDeps } = computeStatus(
        a.dependencies,
        installedSkillOrigins,
        installedMcps,
        this._mcpsCache.map((m) => m.origin),
      );
      out.push(buildAgentEntry(a, status, missingDeps));
    }
    return out;
  }

  listMcps(): McpMetadata[] {
    return this._mcpsCache.map(
      (m) =>
        ({
          ...(m.toJSON() as object),
          mutable: isOriginMutable(m.origin),
        }) as unknown as McpMetadata,
    );
  }
  listSkills(): SkillPojo[] {
    return this._skillsCache.map(
      (s) =>
        ({
          ...(s.toJSON() as object),
          mutable: isOriginMutable(s.origin),
        }) as unknown as SkillPojo,
    );
  }
  listAgents(): AgentPojo[] {
    return this._agentsCache.map(
      (a) =>
        ({
          ...(a.toJSON() as object),
          mutable: isOriginMutable(a.origin),
        }) as unknown as AgentPojo,
    );
  }

  getSkillEntry(fqn: string): SkillEntry | null {
    const s = this._skillsCache.find((x) => x.fqn === fqn);
    if (s === undefined) return null;
    const installedMcps = new Set(this._mcpsCache.map((m) => m.name));
    const installedSkillOrigins = new Set(this._skillsCache.map((x) => x.origin));
    const { status, missingDeps } = computeStatus(
      s.dependencies,
      installedSkillOrigins,
      installedMcps,
      this._mcpsCache.map((m) => m.origin),
    );
    return buildSkillEntry(s, status, missingDeps);
  }

  getAgentEntry(fqn: string): AgentEntry | null {
    const a = this._agentsCache.find((x) => x.fqn === fqn);
    if (a === undefined) return null;
    const installedMcps = new Set(this._mcpsCache.map((m) => m.name));
    const installedSkillOrigins = new Set(this._skillsCache.map((s) => s.origin));
    const { status, missingDeps } = computeStatus(
      a.dependencies,
      installedSkillOrigins,
      installedMcps,
      this._mcpsCache.map((m) => m.origin),
    );
    return buildAgentEntry(a, status, missingDeps);
  }

  async getSkillContent(fqn: string): Promise<string> {
    const s = await this.skill.get(fqn);
    if (s === null) throw new SkillNotFoundError(fqn);
    return s.anchorContent;
  }

  async getAgentContent(fqn: string): Promise<string> {
    const a = await this.agent.get(fqn);
    if (a === null) throw new AgentNotFoundError(fqn);
    return a.anchorContent;
  }

  async getMcpContent(name: string): Promise<string> {
    return this.mcp.getContent(name);
  }

  // ─── Sync POJO read accessors ──

  getSkill(fqn: string): SkillPojo | null {
    const s = this._skillsCache.find((x) => x.fqn === fqn);
    if (s === undefined) return null;
    return {
      ...(s.toJSON() as object),
      mutable: isOriginMutable(s.origin),
    } as unknown as SkillPojo;
  }

  getAgent(fqn: string): AgentPojo | null {
    const a = this._agentsCache.find((x) => x.fqn === fqn);
    if (a === undefined) return null;
    return {
      ...(a.toJSON() as object),
      mutable: isOriginMutable(a.origin),
    } as unknown as AgentPojo;
  }

  getMcp(name: string): McpMetadata | null {
    const m = this._mcpsCache.find((x) => x.name === name);
    if (m === undefined) return null;
    return {
      ...(m.toJSON() as object),
      mutable: isOriginMutable(m.origin),
    } as unknown as McpMetadata;
  }

  // ─── Mutations: legacy compat API ──

  async updateSkillContent(fqn: string, content: string): Promise<SkillPojo> {
    const updated = await this.skill.updateAnchor(fqn, content);
    await this.refresh();
    return {
      ...(updated.toJSON() as object),
      mutable: isOriginMutable(updated.origin),
    } as unknown as SkillPojo;
  }

  async updateAgentContent(fqn: string, content: string): Promise<AgentPojo> {
    const updated = await this.agent.updateAnchor(fqn, content);
    await this.refresh();
    return {
      ...(updated.toJSON() as object),
      mutable: isOriginMutable(updated.origin),
    } as unknown as AgentPojo;
  }

  async updateMcpContent(name: string, content: string): Promise<void> {
    await this.mcp.updateContent(name, content);
    await this.refresh();
  }

  async updateSkillMetadata(fqn: string, patch: SkillMetadataPatch): Promise<SkillPojo> {
    const updated = await this.skill.updateMetadata(fqn, patch as Record<string, unknown>);
    await this.refresh();
    return {
      ...(updated.toJSON() as object),
      mutable: isOriginMutable(updated.origin),
    } as unknown as SkillPojo;
  }

  async updateAgentMetadata(fqn: string, patch: AgentMetadataPatch): Promise<AgentPojo> {
    const updated = await this.agent.updateMetadata(fqn, patch as Record<string, unknown>);
    await this.refresh();
    return {
      ...(updated.toJSON() as object),
      mutable: isOriginMutable(updated.origin),
    } as unknown as AgentPojo;
  }

  async removeSkill(fqn: string): Promise<void> {
    await this.deleteSkill(fqn);
    await this.refresh();
  }

  async removeAgent(fqn: string): Promise<void> {
    await this.deleteAgent(fqn);
    await this.refresh();
  }

  async removeMcp(name: string): Promise<void> {
    await this.deleteMcp(name);
    await this.refresh();
  }

  // ─── Streaming entries (for runtime materialisation) ─

  async *agentEntries(fqn: string): AsyncIterable<{ relPath: string; content: Buffer }> {
    if (!(await this.agent.has(fqn))) throw new AgentNotFoundError(fqn);
    for await (const f of this.agent.streamFiles(fqn)) {
      yield { relPath: f.relPath, content: f.content };
    }
  }

  async *skillEntries(fqn: string): AsyncIterable<{ relPath: string; content: Buffer }> {
    if (!(await this.skill.has(fqn))) throw new SkillNotFoundError(fqn);
    for await (const f of this.skill.streamFiles(fqn)) {
      yield { relPath: f.relPath, content: f.content };
    }
  }

  // ─── Resolve from local catalog (runtime-facing) ─────
  //
  // `resolveAgent(fqn)` walks the *already-installed* graph for an
  // agent: no network, just local cache lookup. Used by the runtime
  // when materialising a session workdir.
  //
  // Skills/mcps in the dep graph are looked up by origin (since dep
  // refs are origin-only). The cache holds origin → entity for both,
  // so this is O(deps) lookups against a Map.

  resolveAgent(fqn: string): AgentResolveResult {
    const agent = this._agentsCache.find((a) => a.fqn === fqn);
    if (agent === undefined) throw new AgentNotFoundError(fqn);

    const skillByOrigin = new Map(this._skillsCache.map((s) => [s.origin, s]));
    const mcpByOrigin = new Map(this._mcpsCache.map((m) => [m.origin, m]));

    const visited = new Set<string>();
    const orderedSkills: Skill[] = [];
    const mcpFqns = new Set<string>();

    const walk = (skillOrigins: readonly string[], mcpOrigins: readonly string[]): void => {
      for (const o of mcpOrigins) {
        const m = mcpByOrigin.get(o);
        if (m !== undefined) mcpFqns.add(m.name);
      }
      for (const o of skillOrigins) {
        if (visited.has(o)) continue;
        visited.add(o);
        const skill = skillByOrigin.get(o);
        if (skill === undefined) continue;
        walk(skill.dependencies.skills, skill.dependencies.mcps);
        orderedSkills.push(skill);
      }
    };

    walk(agent.dependencies.skills, agent.dependencies.mcps);

    return {
      agent: agent.toJSON() as unknown as AgentPojo,
      skills: orderedSkills.map((s) => ({ skill: s.toJSON() as unknown as SkillPojo })),
      mcps: [...mcpFqns].map((name) => ({ name })),
    };
  }

  resolveSkillFromCatalog(fqn: string): SkillResolveResult {
    const root = this._skillsCache.find((s) => s.fqn === fqn);
    if (root === undefined) throw new SkillNotFoundError(fqn);
    const skillByOrigin = new Map(this._skillsCache.map((s) => [s.origin, s]));
    const mcpByOrigin = new Map(this._mcpsCache.map((m) => [m.origin, m]));
    const visited = new Set<string>();
    const ordered: Skill[] = [];
    const mcpFqns = new Set<string>();

    const walk = (origin: string): void => {
      if (visited.has(origin)) return;
      visited.add(origin);
      const skill = skillByOrigin.get(origin);
      if (skill === undefined) return;
      for (const o of skill.dependencies.mcps) {
        const m = mcpByOrigin.get(o);
        if (m !== undefined) mcpFqns.add(m.name);
      }
      for (const o of skill.dependencies.skills) walk(o);
      ordered.push(skill);
    };
    walk(root.origin);

    return {
      skill: root.toJSON() as unknown as SkillPojo,
      skills: ordered.map((s) => ({ skill: s.toJSON() as unknown as SkillPojo })),
      mcps: [...mcpFqns].map((name) => ({ name })),
    };
  }

  // ─── Rescan / cache management ────────────────────────

  private _skillsCache: Skill[] = [];
  private _agentsCache: Agent[] = [];
  private _mcpsCache: Mcp[] = [];
  private _lastScanAt = 0;

  async rescan(): Promise<void> {
    await this.refresh();
    this._lastScanAt = Date.now();
  }

  async rescanIfStale(maxAgeMs = 5000): Promise<void> {
    if (Date.now() - this._lastScanAt > maxAgeMs) await this.rescan();
  }

  private async refresh(): Promise<void> {
    const [skills, agents, mcps] = await Promise.all([
      this.skill.list(),
      this.agent.list(),
      this.mcp.list(),
    ]);
    this._skillsCache = skills;
    this._agentsCache = agents;
    this._mcpsCache = mcps;
  }

  // ─── Internals: cross-entity resolve walkers ──────

  private async walkSkill(origin: string, ctx: ResolveContext, isRoot: boolean): Promise<void> {
    if (ctx.visited.has(origin)) return;
    ctx.visited.add(origin);

    // Check whether this origin is already installed locally. For DEPS
    // (isRoot=false), already-installed entries short-circuit the fetch:
    // we surface them in `alreadyInstalled` and don't re-resolve. For ROOT,
    // we still re-fetch (a same-origin reinstall acts as a sync from
    // upstream — the user explicitly asked for this URL). The fact that
    // it was already installed is recorded on the plan node so the
    // dashboard can swap "Install" for "Sync from upstream" in the UI.
    const localExisting = await this.skill.getByOrigin(origin);
    if (!isRoot && localExisting !== null) {
      ctx.alreadyInstalled.push({
        kind: "skill",
        node: {
          fqn: localExisting.fqn,
          origin: localExisting.origin,
          anchorContent: localExisting.anchorContent,
          frontmatterSha256: localExisting.frontmatterSha256,
          depsRefs: {
            skills: [...localExisting.dependencies.skills],
            mcps: [...localExisting.dependencies.mcps],
          },
        },
      });
      return;
    }

    const plan = await this.skill.resolve(origin);
    if (plan.conflict !== null) {
      ctx.conflicts.push({
        kind: "skill",
        origin: plan.conflict.origin,
        fqn: plan.conflict.fqn,
        reason: plan.conflict.reason,
      });
      return;
    }
    if (plan.node === null) return;

    for (const mcpOrigin of plan.node.depsRefs.mcps) {
      await this.walkMcp(mcpOrigin, ctx, false);
    }
    for (const skillOrigin of plan.node.depsRefs.skills) {
      await this.walkSkill(skillOrigin, ctx, false);
    }
    ctx.toInstall.push({
      kind: "skill",
      node: plan.node,
      ...(localExisting !== null ? { wasAlreadyInstalled: true } : {}),
    });
  }

  private async walkAgent(origin: string, ctx: ResolveContext): Promise<void> {
    if (ctx.visited.has(origin)) return;
    ctx.visited.add(origin);

    // Agents are always root entries (never dep-referenced by other
    // entities), so the same-origin re-install path is the only way to
    // sync. See `walkSkill` for the rationale on keeping root in
    // toInstall while annotating it as previously installed.
    const localExisting = await this.agent.getByOrigin(origin);

    const plan = await this.agent.resolve(origin);
    if (plan.conflict !== null) {
      ctx.conflicts.push({
        kind: "agent",
        origin: plan.conflict.origin,
        fqn: plan.conflict.fqn,
        reason: plan.conflict.reason,
      });
      return;
    }
    if (plan.node === null) return;

    for (const mcpOrigin of plan.node.depsRefs.mcps) {
      await this.walkMcp(mcpOrigin, ctx, false);
    }
    for (const skillOrigin of plan.node.depsRefs.skills) {
      await this.walkSkill(skillOrigin, ctx, false);
    }
    ctx.toInstall.push({
      kind: "agent",
      node: plan.node,
      ...(localExisting !== null ? { wasAlreadyInstalled: true } : {}),
    });
  }

  private async walkMcp(origin: string, ctx: ResolveContext, isRoot: boolean): Promise<void> {
    if (ctx.visited.has(origin)) return;
    ctx.visited.add(origin);

    const localExisting = await this.mcp.getByOrigin(origin);
    if (!isRoot && localExisting !== null) {
      ctx.alreadyInstalled.push({
        kind: "mcp",
        node: {
          fqn: localExisting.name,
          origin: localExisting.origin,
          content: localExisting.content,
        },
      });
      return;
    }

    const result = await this.resolveMcpAdapter(origin);
    if (result.conflict !== null) {
      ctx.conflicts.push(result.conflict);
      return;
    }
    if (result.node === null) return;
    ctx.toInstall.push({
      kind: "mcp",
      node: result.node,
      ...(localExisting !== null ? { wasAlreadyInstalled: true } : {}),
    });
  }

  // ─── Reads (entity access) ────────────────────────────

  listMcpEntities(): Promise<Mcp[]> {
    return this.mcp.list();
  }
  listSkillEntities(): Promise<Skill[]> {
    return this.skill.list();
  }
  listAgentEntities(): Promise<Agent[]> {
    return this.agent.list();
  }

  // ─── Deletes (with dep protection) ─────────────────

  async deleteAgent(fqn: string): Promise<void> {
    await this.agent.delete(fqn);
    await this.refresh();
  }

  async deleteSkill(fqn: string): Promise<void> {
    const dependents = await this.findSkillDependents(fqn);
    if (dependents.length > 0) throw new HasDependentsError(fqn, dependents);
    await this.skill.delete(fqn);
    await this.refresh();
  }

  async deleteMcp(name: string): Promise<void> {
    const dependents = await this.findMcpDependents(name);
    if (dependents.length > 0) throw new HasDependentsError(name, dependents);
    await this.mcp.delete(name);
    await this.refresh();
  }

  /**
   * Find every skill / agent that depends on the named target.
   * Looks up dependents by the TARGET's origin, since dep refs are
   * origin-only.
   */
  async findSkillDependents(
    targetFqn: string,
  ): Promise<{ kind: "skill" | "agent"; name: string }[]> {
    const target = await this.skill.get(targetFqn);
    if (target === null) return [];
    return this.findDependentsByOrigin(target.origin, "skills");
  }

  async findMcpDependents(
    targetName: string,
  ): Promise<{ kind: "skill" | "agent"; name: string }[]> {
    const target = await this.mcp.get(targetName);
    if (target === null) return [];
    return this.findDependentsByOrigin(target.origin, "mcps");
  }

  /** Generic findDependents by target origin (legacy compat). */
  async findDependents(targetName: string): Promise<{ kind: "skill" | "agent"; name: string }[]> {
    // Try mcp first, then skill (caller passes either spec FQN or
    // skill FQN; whichever resolves wins).
    const mcp = await this.mcp.get(targetName);
    if (mcp !== null) return this.findDependentsByOrigin(mcp.origin, "mcps");
    const skill = await this.skill.get(targetName);
    if (skill !== null) return this.findDependentsByOrigin(skill.origin, "skills");
    return [];
  }

  private async findDependentsByOrigin(
    targetOrigin: string,
    kindBucket: "skills" | "mcps",
  ): Promise<{ kind: "skill" | "agent"; name: string }[]> {
    const out: { kind: "skill" | "agent"; name: string }[] = [];
    for (const s of await this.skill.list()) {
      const refs = s.dependencies[kindBucket];
      if (refs.includes(targetOrigin)) out.push({ kind: "skill", name: s.fqn });
    }
    for (const a of await this.agent.list()) {
      const refs = a.dependencies[kindBucket];
      if (refs.includes(targetOrigin)) out.push({ kind: "agent", name: a.fqn });
    }
    return out;
  }

  // ─── Internals: install dispatch ───────────────────────

  private async installNode(planNode: CatalogPlanNode): Promise<void> {
    if (planNode.kind === "skill") {
      await this.skill.install(planNode.node);
    } else if (planNode.kind === "agent") {
      await this.agent.install(planNode.node);
    } else {
      await this.mcp.install(planNode.node.fqn, planNode.node.origin, planNode.node.content);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────

interface ResolveContext {
  visited: Set<string>;
  toInstall: CatalogPlanNode[];
  alreadyInstalled: CatalogPlanNode[];
  conflicts: CatalogConflict[];
}

function newResolveContext(): ResolveContext {
  return { visited: new Set(), toInstall: [], alreadyInstalled: [], conflicts: [] };
}

function finaliseResolveContext(ctx: ResolveContext): CatalogPlan {
  return {
    toInstall: ctx.toInstall,
    alreadyInstalled: ctx.alreadyInstalled,
    conflicts: ctx.conflicts,
  };
}

function planRefs(planNode: CatalogPlanNode): string[] {
  if (planNode.kind === "mcp") return [];
  // For poison propagation: dep fqns. We don't have fqns at this
  // layer (only origins), but the install loop tracks `poisoned` by
  // installed-fqn — a dep fqn isn't computable until the dep is
  // resolved. Workaround: use origin as the poisoning key.
  // (Both `installed.fqn` and `poisoned.has(<dep-fqn>)` should be the
  // same key; we revisit by storing origin → fqn lookups.)
  return [...planNode.node.depsRefs.skills, ...planNode.node.depsRefs.mcps];
}

function buildSkillEntry(
  s: Skill,
  status: EntryStatus,
  missingDeps: MissingDep[] | undefined,
): SkillEntry {
  const skill = {
    ...(s.toJSON() as object),
    mutable: isOriginMutable(s.origin),
  } as unknown as SkillPojo;
  if (missingDeps !== undefined && missingDeps.length > 0) {
    return { skill, status, missingDeps };
  }
  return { skill, status };
}

function buildAgentEntry(
  a: Agent,
  status: EntryStatus,
  missingDeps: MissingDep[] | undefined,
): AgentEntry {
  const agent = {
    ...(a.toJSON() as object),
    mutable: isOriginMutable(a.origin),
  } as unknown as AgentPojo;
  if (missingDeps !== undefined && missingDeps.length > 0) {
    return { agent, status, missingDeps };
  }
  return { agent, status };
}

/**
 * Compute "ready" / "disabled" status. Dep refs are origin URIs; we
 * check whether each origin has a corresponding installed entity.
 */
function computeStatus(
  deps: { skills: readonly string[]; mcps: readonly string[] },
  installedSkillOrigins: ReadonlySet<string>,
  _installedMcpFqns: ReadonlySet<string>,
  installedMcpOrigins: readonly string[],
): { status: EntryStatus; missingDeps: MissingDep[] | undefined } {
  const missing: MissingDep[] = [];
  for (const skillOrigin of deps.skills) {
    if (!installedSkillOrigins.has(skillOrigin)) {
      missing.push({ kind: "skill", name: skillOrigin });
    }
  }
  const installedMcpOriginSet = new Set(installedMcpOrigins);
  for (const mcpOrigin of deps.mcps) {
    if (!installedMcpOriginSet.has(mcpOrigin)) {
      missing.push({ kind: "mcp", name: mcpOrigin });
    }
  }
  if (missing.length === 0) return { status: "ready", missingDeps: undefined };
  return { status: "disabled", missingDeps: missing };
}

function conflictToError(c: CatalogConflict): Error {
  if (c.reason.kind === "fetch-failed" || c.reason.kind === "parse-failed") {
    return c.reason.cause instanceof Error
      ? c.reason.cause
      : new Error(`catalog ${c.kind} resolve failed: ${c.reason.kind}`);
  }
  return new Error(`catalog ${c.kind} resolve conflict: ${JSON.stringify(c.reason)}`);
}

async function readFirstFile(
  stream: AsyncIterable<EntryFile>,
  preferredRelPath: string | null,
): Promise<string> {
  let fallback: string | null = null;
  for await (const f of stream) {
    if (preferredRelPath !== null && f.relPath === preferredRelPath) {
      return f.content.toString("utf8");
    }
    if (fallback === null) fallback = f.content.toString("utf8");
    if (preferredRelPath === null) break;
  }
  if (fallback === null) {
    throw new Error(
      preferredRelPath !== null
        ? `fetcher yielded no ${preferredRelPath}`
        : "fetcher yielded zero files",
    );
  }
  return fallback;
}

// silence unused-import warnings
void Mcp;
void McpNotFoundError;

// re-exports
export type { ResolvedMcp, ResolvedSkill };

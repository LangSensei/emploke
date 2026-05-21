import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import pino, { type Logger } from "pino";

const silentLogger: Logger = pino({ level: "silent" });

import type { AgentEntity } from "../agent/agent-entity.js";
import { AgentRepository } from "../agent/agent-repository.js";
import { AgentService } from "../agent/agent-service.js";
import { AgentNotFoundError } from "../agent/errors.js";
import { defaultFetcherRegistry } from "../fetcher/index.js";
import { McpNotFoundError } from "../mcp/errors.js";
import type { McpEntity } from "../mcp/mcp-entity.js";
import * as McpFormat from "../mcp/mcp-format.js";
import { McpRepository } from "../mcp/mcp-repository.js";
import { type McpFetcher, McpService } from "../mcp/mcp-service.js";
import type * as schema from "../schema.js";
import { SkillNotFoundError } from "../skill/errors.js";
import type { SkillEntity } from "../skill/skill-entity.js";
import { SkillRepository } from "../skill/skill-repository.js";
import { type SkillFetcher, SkillService } from "../skill/skill-service.js";
import type {
  Agent,
  AgentEntry,
  AgentMetadataPatch,
  AgentResolveResult,
  Mcp,
  ResolvedMcp,
  ResolvedSkill,
  Skill,
  SkillEntry,
  SkillMetadataPatch,
  SkillResolveResult,
} from "../types.js";
import { HasDependentsError } from "./errors.js";
import type {
  CatalogInstalledEntry,
  CatalogInstallFailure,
  CatalogInstallResult,
  CatalogInstallSkip,
  CatalogPlan,
  CatalogPlanNode,
  CatalogSyncResult,
  McpResolveAdapter,
} from "./plan-types.js";
import {
  buildAgentEntry,
  buildSkillEntry,
  isForeignKeyError,
  newCascadeContext,
  projectAgentPojo,
  projectMcpMetadata,
  projectSkillPojo,
} from "./projection.js";
import {
  buildLocalClosure,
  buildUpstreamClosure,
  diffClosures,
  type PipelineServices,
} from "./resolve-pipeline.js";

const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedPlan {
  readonly plan: CatalogPlan;
  readonly expiresAt: number;
}

/**
 * Construction options for {@link CatalogService}.
 */
export interface CatalogOptions {
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly logger?: Logger;
}

/**
 * Internal handle binding the per-entity services + repos + adapter
 * used by {@link CatalogService}. Constructed once by
 * {@link buildCatalogRuntime}; tests can build it manually with
 * fake per-entity services for cross-entity facade tests.
 */
export interface CatalogRuntime {
  readonly mcp: McpService;
  readonly skill: SkillService;
  readonly agent: AgentService;
  readonly mcpRepo: McpRepository;
  readonly skillRepo: SkillRepository;
  readonly agentRepo: AgentRepository;
  readonly resolveMcpAdapter: McpResolveAdapter;
  readonly logger: Logger;
}

export function buildCatalogRuntime(opts: CatalogOptions): CatalogRuntime {
  const fetchers = defaultFetcherRegistry();
  const logger = opts.logger ?? silentLogger;

  const mcpRepo = new McpRepository({ db: opts.db, logger });
  const skillRepo = new SkillRepository({ db: opts.db, logger });
  const agentRepo = new AgentRepository({ db: opts.db, logger });

  const mcpFetcher: McpFetcher = (origin) =>
    fetchers.dispatchFile(origin, "").then((b) => b.toString("utf8"));
  const skillFetcher: SkillFetcher = {
    async fetchAnchor(origin) {
      const buf = await fetchers.dispatchFile(origin, "SKILL.md");
      return buf.toString("utf8");
    },
    fetchTree(origin) {
      return fetchers.dispatchTree(origin);
    },
  };
  const agentFetcher = {
    async fetchAnchor(origin: string) {
      const buf = await fetchers.dispatchFile(origin, "AGENTS.md");
      return buf.toString("utf8");
    },
    fetchTree(origin: string) {
      return fetchers.dispatchTree(origin);
    },
  };

  const mcp = new McpService(mcpRepo, mcpFetcher);
  const skill = new SkillService(skillRepo, skillFetcher, { mcps: mcpRepo });
  const agent = new AgentService(agentRepo, agentFetcher, {
    skills: skillRepo,
    mcps: mcpRepo,
  });

  const resolveMcpAdapter: McpResolveAdapter = async (origin) => {
    try {
      const buf = await fetchers.dispatchFile(origin, "");
      const content = buf.toString("utf8");
      const parsed = McpFormat.parse(content, `resolve:${origin}`);
      const name = parsed.meta.name;
      const merged = McpFormat.writeMeta(content, { name }, `resolve:${origin}`);
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

  return {
    mcp,
    skill,
    agent,
    mcpRepo,
    skillRepo,
    agentRepo,
    resolveMcpAdapter,
    logger,
  };
}

/**
 * Unified catalog facade. Holds both write (install / update / delete)
 * and read (list / get / resolve / dependent-lookup) operations.
 *
 * Reads and writes share the same backing per-entity services/repos —
 * writes are immediately visible to subsequent reads with no cache
 * invalidation. The single in-memory `planCache` powers the
 * preview/apply UX (`cachePlan` / `takePlan`).
 */
export class CatalogService {
  private readonly planCache = new Map<string, CachedPlan>();

  constructor(private readonly rt: CatalogRuntime) {}

  // ─── Install ──────────────────────────────────────────

  async install(plan: CatalogPlan): Promise<CatalogInstallResult> {
    const installed: CatalogInstalledEntry[] = [];
    const failed: CatalogInstallFailure[] = [];
    const skipped: CatalogInstallSkip[] = plan.alreadyInstalled.map((n) => ({
      kind: n.kind,
      fqn: n.node.fqn,
      reason: (n.disposition === "up-to-date" ? "up-to-date" : "already-installed") as
        | "already-installed"
        | "up-to-date",
    }));

    const poisoned = new Set<string>();
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
        const persisted = await this.installNode(planNode);
        installed.push(toInstalledEntry(planNode.kind, fqn, persisted));
      } catch (err) {
        failed.push({ kind: planNode.kind, fqn, error: errorToWire(err) });
        poisoned.add(origin);
      }
    }

    return { installed, skipped, failed };
  }

  async installSkill(origin: string): Promise<CatalogInstallResult> {
    return this.install(await this.resolveSkill(origin));
  }

  async installAgent(origin: string): Promise<CatalogInstallResult> {
    return this.install(await this.resolveAgentFromOrigin(origin));
  }

  async installMcpFromOrigin(origin: string): Promise<CatalogInstallResult> {
    return this.install(await this.resolveMcp(origin));
  }

  /**
   * Apply a sync plan: delete the old fqn on identity change, then
   * run the regular install. NOT atomic across delete + install.
   */
  async applySync(plan: CatalogPlan): Promise<CatalogSyncResult> {
    if (plan.identityChange !== undefined) {
      const ic = plan.identityChange;
      if (ic.kind === "skill") await this.rt.skill.delete(ic.oldFqn);
      else if (ic.kind === "agent") await this.rt.agent.delete(ic.oldFqn);
      else await this.rt.mcp.delete(ic.oldFqn);
    }
    const result = await this.install(plan);
    return { ...result, orphansFlagged: plan.orphans };
  }

  // ─── Per-entry flag flips ────────────────────────────

  async acknowledgeSkillPrereqs(fqn: string): Promise<Skill> {
    const updated = await this.rt.skill.acknowledgePrereqs(fqn);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  async acknowledgeAgentPrereqs(fqn: string): Promise<Agent> {
    const updated = await this.rt.agent.acknowledgePrereqs(fqn);
    return projectAgentPojo(updated);
  }

  async disableAgent(fqn: string): Promise<Agent> {
    const updated = await this.rt.agent.disableByUser(fqn);
    return projectAgentPojo(updated);
  }

  async enableAgent(fqn: string): Promise<Agent> {
    const updated = await this.rt.agent.enableByUser(fqn);
    return projectAgentPojo(updated);
  }

  // ─── Content / metadata updates ──────────────────────

  async updateSkillContent(fqn: string, content: string): Promise<Skill> {
    const updated = await this.rt.skill.updateAnchor(fqn, content);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  async updateAgentContent(fqn: string, content: string): Promise<Agent> {
    const updated = await this.rt.agent.updateAnchor(fqn, content);
    return projectAgentPojo(updated);
  }

  async updateMcpContent(name: string, content: string): Promise<void> {
    await this.rt.mcp.updateContent(name, content);
  }

  async updateSkillMetadata(fqn: string, patch: SkillMetadataPatch): Promise<Skill> {
    const updated = await this.rt.skill.updateMetadata(fqn, patch as Record<string, unknown>);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  async updateAgentMetadata(fqn: string, patch: AgentMetadataPatch): Promise<Agent> {
    const updated = await this.rt.agent.updateMetadata(fqn, patch as Record<string, unknown>);
    return projectAgentPojo(updated);
  }

  // ─── Deletes (with dep-protection error wrapping) ────

  async deleteAgent(fqn: string): Promise<void> {
    await this.rt.agent.delete(fqn);
  }

  async deleteSkill(fqn: string): Promise<void> {
    try {
      await this.rt.skill.delete(fqn);
    } catch (err) {
      if (isForeignKeyError(err)) {
        const dependents = await this.findSkillDependents(fqn);
        throw new HasDependentsError(fqn, dependents);
      }
      throw err;
    }
  }

  async deleteMcp(fqn: string): Promise<void> {
    try {
      await this.rt.mcp.delete(fqn);
    } catch (err) {
      if (isForeignKeyError(err)) {
        const dependents = await this.findMcpDependents(fqn);
        throw new HasDependentsError(fqn, dependents);
      }
      throw err;
    }
  }

  // ─── Resolve (cross-entity walk, no writes) ──────────

  resolveSkill(origin: string): Promise<CatalogPlan> {
    return this.runResolvePipeline({ kind: "skill", origin }, false);
  }

  resolveAgentFromOrigin(origin: string): Promise<CatalogPlan> {
    return this.runResolvePipeline({ kind: "agent", origin }, false);
  }

  resolveMcp(origin: string): Promise<CatalogPlan> {
    return this.runResolvePipeline({ kind: "mcp", origin }, false);
  }

  async resolveSyncSkill(fqn: string): Promise<CatalogPlan> {
    const local = await this.rt.skill.get(fqn);
    if (local === null) throw new SkillNotFoundError(fqn);
    return this.runResolvePipeline({ kind: "skill", origin: local.origin }, true);
  }

  async resolveSyncAgent(fqn: string): Promise<CatalogPlan> {
    const local = await this.rt.agent.get(fqn);
    if (local === null) throw new AgentNotFoundError(fqn);
    return this.runResolvePipeline({ kind: "agent", origin: local.origin }, true);
  }

  async resolveSyncMcp(name: string): Promise<CatalogPlan> {
    const local = await this.rt.mcp.get(name);
    if (local === null) throw new McpNotFoundError(name);
    return this.runResolvePipeline({ kind: "mcp", origin: local.origin }, true);
  }

  // ─── Preview/apply token cache ───────────────────────

  cachePlan(plan: CatalogPlan): string {
    this.evictExpiredPlans();
    const token = randomUUID();
    this.planCache.set(token, { plan, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
    return token;
  }

  takePlan(token: string): CatalogPlan | null {
    const entry = this.planCache.get(token);
    if (entry === undefined) return null;
    this.planCache.delete(token);
    return entry.expiresAt < Date.now() ? null : entry.plan;
  }

  private evictExpiredPlans(): void {
    const now = Date.now();
    for (const [token, entry] of this.planCache) {
      if (entry.expiresAt < now) this.planCache.delete(token);
    }
  }

  // ─── Listing / lookup with DTO projection ─────────────

  async listSkillEntries(): Promise<SkillEntry[]> {
    const ctx = await this.loadCascadeContext();
    return [...ctx.skillByFqn.values()].map((s) => buildSkillEntry(s, ctx));
  }

  async listAgentEntries(): Promise<AgentEntry[]> {
    const [agents, ctx] = await Promise.all([this.rt.agent.list(), this.loadCascadeContext()]);
    return agents.map((a) => buildAgentEntry(a, ctx));
  }

  async listMcps(): Promise<Mcp[]> {
    const ctx = await this.loadCascadeContext();
    return [...ctx.mcpByFqn.values()].map((m) => projectMcpMetadata(m, ctx));
  }

  async listSkills(): Promise<Skill[]> {
    const ctx = await this.loadCascadeContext();
    return [...ctx.skillByFqn.values()].map((s) => projectSkillPojo(s, ctx));
  }

  async listAgents(): Promise<Agent[]> {
    const agents = await this.rt.agent.list();
    return agents.map((a) => projectAgentPojo(a));
  }

  async getSkillEntry(fqn: string): Promise<SkillEntry | null> {
    const s = await this.rt.skill.get(fqn);
    if (s === null) return null;
    const ctx = await this.loadCascadeContext();
    return buildSkillEntry(s, ctx);
  }

  async getAgentEntry(fqn: string): Promise<AgentEntry | null> {
    const a = await this.rt.agent.get(fqn);
    if (a === null) return null;
    const ctx = await this.loadCascadeContext();
    return buildAgentEntry(a, ctx);
  }

  async getSkillContent(fqn: string): Promise<string> {
    const s = await this.rt.skill.get(fqn);
    if (s === null) throw new SkillNotFoundError(fqn);
    return this.rt.skill.getAnchor(fqn);
  }

  async getAgentContent(fqn: string): Promise<string> {
    const a = await this.rt.agent.get(fqn);
    if (a === null) throw new AgentNotFoundError(fqn);
    return this.rt.agent.getAnchor(fqn);
  }

  async getMcpContent(fqn: string): Promise<string> {
    return this.rt.mcp.getContent(fqn);
  }

  /**
   * Parsed JSON of the MCP spec with emploke's internal `_meta` block
   * stripped — the form runtime adapters consume when writing
   * client-side config files.
   */
  async getMcpRuntimeConfig(fqn: string): Promise<Record<string, unknown>> {
    const raw = await this.rt.mcp.getContent(fqn);
    return McpFormat.stripMeta(raw, `mcps:${fqn}`);
  }

  async getSkill(fqn: string): Promise<Skill | null> {
    const s = await this.rt.skill.get(fqn);
    if (s === null) return null;
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(s, ctx);
  }

  async getAgent(fqn: string): Promise<Agent | null> {
    const a = await this.rt.agent.get(fqn);
    if (a === null) return null;
    return projectAgentPojo(a);
  }

  async getMcp(name: string): Promise<Mcp | null> {
    const m = await this.rt.mcp.get(name);
    if (m === null) return null;
    const ctx = await this.loadCascadeContext();
    return projectMcpMetadata(m, ctx);
  }

  // ─── Entity lists (rich entities, for callers that need methods) ─

  listMcpEntities(): Promise<McpEntity[]> {
    return this.rt.mcp.list();
  }
  listSkillEntities(): Promise<SkillEntity[]> {
    return this.rt.skill.list();
  }
  listAgentEntities(): Promise<AgentEntity[]> {
    return this.rt.agent.list();
  }

  // ─── Streaming files (runtime materialisation) ───────

  async *agentEntries(fqn: string): AsyncIterable<{ relPath: string; content: Buffer }> {
    if (!(await this.rt.agent.has(fqn))) throw new AgentNotFoundError(fqn);
    for await (const f of this.rt.agent.streamFiles(fqn)) {
      yield { relPath: f.relPath, content: f.content };
    }
  }

  async *skillEntries(fqn: string): AsyncIterable<{ relPath: string; content: Buffer }> {
    if (!(await this.rt.skill.has(fqn))) throw new SkillNotFoundError(fqn);
    for await (const f of this.rt.skill.streamFiles(fqn)) {
      yield { relPath: f.relPath, content: f.content };
    }
  }

  // ─── Resolve from local catalog (runtime-facing reads) ─

  async resolveAgent(fqn: string): Promise<AgentResolveResult> {
    const [agents, skills, mcps] = await Promise.all([
      this.rt.agent.list(),
      this.rt.skill.list(),
      this.rt.mcp.list(),
    ]);
    const agent = agents.find((a) => a.fqn === fqn);
    if (agent === undefined) throw new AgentNotFoundError(fqn);
    const ctx = newCascadeContext(skills, agents, mcps);
    const visited = new Set<string>();
    const orderedSkills: SkillEntity[] = [];
    const mcpFqns = new Set<string>();
    const walk = (
      skillDeps: ReadonlyArray<{ readonly fqn: string }>,
      mcpDeps: ReadonlyArray<{ readonly fqn: string }>,
    ): void => {
      for (const d of mcpDeps) {
        const m = ctx.mcpByFqn.get(d.fqn);
        if (m !== undefined) mcpFqns.add(m.fqn);
      }
      for (const d of skillDeps) {
        if (visited.has(d.fqn)) continue;
        visited.add(d.fqn);
        const skill = ctx.skillByFqn.get(d.fqn);
        if (skill === undefined) continue;
        walk(skill.dependencies.skills, skill.dependencies.mcps);
        orderedSkills.push(skill);
      }
    };
    walk(agent.dependencies.skills, agent.dependencies.mcps);
    return {
      agent: projectAgentPojo(agent),
      skills: orderedSkills.map<ResolvedSkill>((s) => ({ skill: projectSkillPojo(s, ctx) })),
      mcps: [...mcpFqns].map<ResolvedMcp>((mcpFqn) => ({ fqn: mcpFqn })),
    };
  }

  async resolveSkillFromCatalog(fqn: string): Promise<SkillResolveResult> {
    const [skills, agents, mcps] = await Promise.all([
      this.rt.skill.list(),
      this.rt.agent.list(),
      this.rt.mcp.list(),
    ]);
    const root = skills.find((s) => s.fqn === fqn);
    if (root === undefined) throw new SkillNotFoundError(fqn);
    const ctx = newCascadeContext(skills, agents, mcps);
    const visited = new Set<string>();
    const ordered: SkillEntity[] = [];
    const mcpFqns = new Set<string>();
    const walk = (skillFqn: string): void => {
      if (visited.has(skillFqn)) return;
      visited.add(skillFqn);
      const skill = ctx.skillByFqn.get(skillFqn);
      if (skill === undefined) return;
      for (const d of skill.dependencies.mcps) {
        const m = ctx.mcpByFqn.get(d.fqn);
        if (m !== undefined) mcpFqns.add(m.fqn);
      }
      for (const d of skill.dependencies.skills) walk(d.fqn);
      ordered.push(skill);
    };
    walk(root.fqn);
    return {
      skill: projectSkillPojo(root, ctx),
      skills: ordered.map<ResolvedSkill>((s) => ({ skill: projectSkillPojo(s, ctx) })),
      mcps: [...mcpFqns].map<ResolvedMcp>((mcpFqn) => ({ fqn: mcpFqn })),
    };
  }

  // ─── Reverse-dep lookups ─────────────────────────────

  async findSkillDependents(
    targetFqn: string,
  ): Promise<{ kind: "skill" | "agent"; name: string }[]> {
    const [agents, skills] = await Promise.all([
      this.rt.skillRepo.findDependentAgents(targetFqn),
      this.rt.skillRepo.findDependentSkills(targetFqn),
    ]);
    return [
      ...skills.map((name) => ({ kind: "skill" as const, name })),
      ...agents.map((name) => ({ kind: "agent" as const, name })),
    ];
  }

  async findMcpDependents(targetFqn: string): Promise<{ kind: "skill" | "agent"; name: string }[]> {
    const [agents, skills] = await Promise.all([
      this.rt.mcpRepo.findDependentAgents(targetFqn),
      this.rt.mcpRepo.findDependentSkills(targetFqn),
    ]);
    return [
      ...skills.map((name) => ({ kind: "skill" as const, name })),
      ...agents.map((name) => ({ kind: "agent" as const, name })),
    ];
  }

  async findDependents(targetFqn: string): Promise<{ kind: "skill" | "agent"; name: string }[]> {
    const mcp = await this.rt.mcp.get(targetFqn);
    if (mcp !== null) return this.findMcpDependents(targetFqn);
    const skill = await this.rt.skill.get(targetFqn);
    if (skill !== null) return this.findSkillDependents(targetFqn);
    return [];
  }

  // ─── Internals ───────────────────────────────────────

  private async installNode(
    planNode: CatalogPlanNode,
  ): Promise<SkillEntity | AgentEntity | McpEntity> {
    if (planNode.kind === "skill") return this.rt.skill.install(planNode.node);
    if (planNode.kind === "agent") return this.rt.agent.install(planNode.node);
    return this.rt.mcp.install(planNode.node.fqn, planNode.node.origin, planNode.node.content);
  }

  private async runResolvePipeline(
    root: { kind: "skill" | "agent" | "mcp"; origin: string },
    isSync: boolean,
  ): Promise<CatalogPlan> {
    const services: PipelineServices = {
      skill: this.rt.skill,
      agent: this.rt.agent,
      mcp: this.rt.mcp,
      resolveMcpAdapter: this.rt.resolveMcpAdapter,
    };
    const upstream = await buildUpstreamClosure(root, services, {
      mode: isSync ? "sync" : "install",
    });
    const local = await buildLocalClosure([root.origin], services);
    const globalReverseDepIndex = isSync
      ? await this.computeReverseDepIndex(root.origin)
      : undefined;
    const diff = diffClosures(upstream.closure, local, {
      rootOrigin: root.origin,
      rootKind: root.kind,
      isSync,
      ...(globalReverseDepIndex !== undefined ? { globalReverseDepIndex } : {}),
    });
    const noFetchNeeded =
      diff.toInstall.length === 0 &&
      upstream.conflicts.length === 0 &&
      diff.identityChange === undefined;
    const upToDate = isSync && noFetchNeeded && diff.orphans.length === 0;
    return {
      toInstall: diff.toInstall as CatalogPlanNode[],
      alreadyInstalled: diff.alreadyInstalled as CatalogPlanNode[],
      conflicts: upstream.conflicts,
      rootOrigin: root.origin,
      isSync,
      ...(diff.identityChange !== undefined ? { identityChange: diff.identityChange } : {}),
      orphans: diff.orphans,
      upToDate,
    };
  }

  private async computeReverseDepIndex(rootOrigin: string): Promise<Set<string>> {
    const [skills, agents, mcps] = await Promise.all([
      this.rt.skill.list(),
      this.rt.agent.list(),
      this.rt.mcp.list(),
    ]);
    const skillOriginByFqn = new Map(skills.map((s) => [s.fqn, s.origin] as const));
    const mcpOriginByFqn = new Map(mcps.map((m) => [m.fqn, m.origin] as const));
    const referenced = new Set<string>();
    for (const a of agents) {
      if (a.origin === rootOrigin) continue;
      for (const d of a.dependencies.skills) {
        const o = skillOriginByFqn.get(d.fqn);
        if (o !== undefined) referenced.add(o);
      }
      for (const d of a.dependencies.mcps) {
        const o = mcpOriginByFqn.get(d.fqn);
        if (o !== undefined) referenced.add(o);
      }
    }
    for (const s of skills) {
      if (s.origin === rootOrigin) continue;
      for (const d of s.dependencies.skills) {
        const o = skillOriginByFqn.get(d.fqn);
        if (o !== undefined) referenced.add(o);
      }
      for (const d of s.dependencies.mcps) {
        const o = mcpOriginByFqn.get(d.fqn);
        if (o !== undefined) referenced.add(o);
      }
    }
    return referenced;
  }

  private async loadCascadeContext() {
    const [skills, agents, mcps] = await Promise.all([
      this.rt.skill.list(),
      this.rt.agent.list(),
      this.rt.mcp.list(),
    ]);
    return newCascadeContext(skills, agents, mcps);
  }
}

function planRefs(planNode: CatalogPlanNode): string[] {
  if (planNode.kind === "mcp") return [];
  return [...planNode.node.depsRefs.skills, ...planNode.node.depsRefs.mcps];
}

function toInstalledEntry(
  kind: "mcp" | "skill" | "agent",
  fqn: string,
  entity: SkillEntity | AgentEntity | McpEntity,
): CatalogInstalledEntry {
  if (kind === "mcp") return { kind, fqn };
  const e = entity as SkillEntity | AgentEntity;
  const prereqs = e.prereqs;
  const out: CatalogInstalledEntry = { kind, fqn, prereqsAck: e.prereqsAck };
  if (prereqs !== undefined && prereqs.trim().length > 0) return { ...out, prereqs };
  return out;
}

function errorToWire(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { name: "Error", message: err };
  return { name: "Error", message: String(err) };
}

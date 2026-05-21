import type { Agent } from "../agent/agent-entity.js";
import type {
  AgentMetadataPatch,
  Agent as AgentPojo,
  SkillMetadataPatch,
  Skill as SkillPojo,
} from "../dto/types.js";
import { Mcp } from "../mcp/mcp-entity.js";
import type { Skill } from "../skill/skill-entity.js";
import type { CatalogQueries, CatalogRuntime } from "./catalog-queries.js";
import { HasDependentsError } from "./errors.js";
import type {
  CatalogInstalledEntry,
  CatalogInstallFailure,
  CatalogInstallResult,
  CatalogInstallSkip,
  CatalogPlan,
  CatalogPlanNode,
  CatalogSyncResult,
} from "./plan-types.js";
import {
  isForeignKeyError,
  newCascadeContext,
  projectAgentPojo,
  projectSkillPojo,
} from "./projection.js";

/**
 * Write side of the catalog facade. All mutations live here; reads
 * live on {@link CatalogQueries}. The service holds a reference to
 * the queries so install convenience methods (`installSkill(origin)`)
 * can delegate the resolve step.
 *
 * Both classes share the same {@link CatalogRuntime} (per-entity
 * services + repos), so writes performed here are immediately visible
 * to subsequent queries calls — there is no in-memory snapshot to
 * invalidate.
 */
export class CatalogService {
  constructor(
    private readonly rt: CatalogRuntime,
    private readonly queries: CatalogQueries,
  ) {}

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
    return this.install(await this.queries.resolveSkill(origin));
  }

  async installAgent(origin: string): Promise<CatalogInstallResult> {
    return this.install(await this.queries.resolveAgentFromOrigin(origin));
  }

  async installMcpFromOrigin(origin: string): Promise<CatalogInstallResult> {
    return this.install(await this.queries.resolveMcp(origin));
  }

  /**
   * Apply a sync plan: delete the old fqn on identity change, then
   * run the regular install. NOT atomic across delete + install
   * (see original CatalogManager docs).
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

  async acknowledgeSkillPrereqs(fqn: string): Promise<SkillPojo> {
    const updated = await this.rt.skill.acknowledgePrereqs(fqn);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  async acknowledgeAgentPrereqs(fqn: string): Promise<AgentPojo> {
    const updated = await this.rt.agent.acknowledgePrereqs(fqn);
    return projectAgentPojo(updated);
  }

  async disableAgent(fqn: string): Promise<AgentPojo> {
    const updated = await this.rt.agent.disableByUser(fqn);
    return projectAgentPojo(updated);
  }

  async enableAgent(fqn: string): Promise<AgentPojo> {
    const updated = await this.rt.agent.enableByUser(fqn);
    return projectAgentPojo(updated);
  }

  // ─── Content / metadata updates ──────────────────────

  async updateSkillContent(fqn: string, content: string): Promise<SkillPojo> {
    const updated = await this.rt.skill.updateAnchor(fqn, content);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  async updateAgentContent(fqn: string, content: string): Promise<AgentPojo> {
    const updated = await this.rt.agent.updateAnchor(fqn, content);
    return projectAgentPojo(updated);
  }

  async updateMcpContent(name: string, content: string): Promise<void> {
    await this.rt.mcp.updateContent(name, content);
  }

  async updateSkillMetadata(fqn: string, patch: SkillMetadataPatch): Promise<SkillPojo> {
    const updated = await this.rt.skill.updateMetadata(fqn, patch as Record<string, unknown>);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  async updateAgentMetadata(fqn: string, patch: AgentMetadataPatch): Promise<AgentPojo> {
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
        const dependents = await this.queries.findSkillDependents(fqn);
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
        const dependents = await this.queries.findMcpDependents(fqn);
        throw new HasDependentsError(fqn, dependents);
      }
      throw err;
    }
  }

  // ─── Internals ───────────────────────────────────────

  private async installNode(planNode: CatalogPlanNode): Promise<Skill | Agent | Mcp> {
    if (planNode.kind === "skill") return this.rt.skill.install(planNode.node);
    if (planNode.kind === "agent") return this.rt.agent.install(planNode.node);
    return this.rt.mcp.install(planNode.node.fqn, planNode.node.origin, planNode.node.content);
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
  entity: Skill | Agent | Mcp,
): CatalogInstalledEntry {
  if (kind === "mcp") return { kind, fqn };
  const e = entity as Skill | Agent;
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

// keep imports used by type-only places
void Mcp;

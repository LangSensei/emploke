/**
 * Pure projection + cascade-status helpers shared by `CatalogService`
 * (writes; needs to project the post-write result into DTOs) and
 * `CatalogQueries` (reads). No I/O — every function operates over
 * already-loaded entities + a {@link CascadeContext} snapshot.
 */

import type { Agent } from "../agent/agent-entity.js";
import type {
  AgentEntry,
  Agent as AgentPojo,
  BlockedDep,
  BlockedReason,
  EntryStatus,
  McpMetadata,
  MissingDep,
  SkillEntry,
  Skill as SkillPojo,
} from "../dto/types.js";
import type { Mcp } from "../mcp/mcp-entity.js";
import { isOriginMutable } from "../origin-mutability.js";
import type { Skill } from "../skill/skill-entity.js";

export interface CascadeContext {
  readonly skillByFqn: ReadonlyMap<string, Skill>;
  readonly mcpByFqn: ReadonlyMap<string, Mcp>;
  readonly skillCache: Map<string, ComputedStatus>;
  readonly inFlight: Set<string>;
  readonly referencedSkillFqns: ReadonlySet<string>;
  readonly referencedMcpFqns: ReadonlySet<string>;
}

export interface ComputedStatus {
  readonly status: EntryStatus;
  readonly reason?: BlockedReason;
}

export function newCascadeContext(
  skills: Skill[],
  agents: Agent[],
  mcps: Mcp[],
): CascadeContext {
  const referencedSkillFqns = new Set<string>();
  const referencedMcpFqns = new Set<string>();
  for (const a of agents) {
    for (const d of a.dependencies.skills) referencedSkillFqns.add(d.fqn);
    for (const d of a.dependencies.mcps) referencedMcpFqns.add(d.fqn);
  }
  for (const s of skills) {
    for (const d of s.dependencies.skills) referencedSkillFqns.add(d.fqn);
    for (const d of s.dependencies.mcps) referencedMcpFqns.add(d.fqn);
  }
  return {
    skillByFqn: new Map(skills.map((s) => [s.fqn, s] as const)),
    mcpByFqn: new Map(mcps.map((m) => [m.fqn, m] as const)),
    skillCache: new Map(),
    inFlight: new Set(),
    referencedSkillFqns,
    referencedMcpFqns,
  };
}

export function projectSkillPojo(s: Skill, ctx: CascadeContext): SkillPojo {
  return {
    ...(s.toJSON() as object),
    mutable: isOriginMutable(s.origin),
    orphaned: !ctx.referencedSkillFqns.has(s.fqn),
  } as unknown as SkillPojo;
}

export function projectAgentPojo(a: Agent): AgentPojo {
  return {
    ...(a.toJSON() as object),
    mutable: isOriginMutable(a.origin),
  } as unknown as AgentPojo;
}

export function projectMcpMetadata(m: Mcp, ctx: CascadeContext): McpMetadata {
  return {
    ...(m.toJSON() as object),
    mutable: isOriginMutable(m.origin),
    orphaned: !ctx.referencedMcpFqns.has(m.fqn),
  } as unknown as McpMetadata;
}

interface SelfConditions {
  readonly prereqs: string | undefined;
  readonly prereqsAck: boolean;
  readonly orphaned: boolean;
  readonly disabledByUser: boolean;
}

function computeWithDeps(
  self: SelfConditions,
  deps: {
    skills: ReadonlyArray<{ readonly fqn: string }>;
    mcps: ReadonlyArray<{ readonly fqn: string }>;
  },
  ctx: CascadeContext,
): ComputedStatus {
  const reason: {
    needsPrereqsAck?: true;
    disabledByUser?: true;
    orphaned?: true;
    missingDeps?: MissingDep[];
    blockedDeps?: BlockedDep[];
  } = {};
  if (!self.prereqsAck && (self.prereqs ?? "").trim().length > 0) {
    reason.needsPrereqsAck = true;
  }
  if (self.disabledByUser) reason.disabledByUser = true;
  if (self.orphaned) reason.orphaned = true;

  const missing: MissingDep[] = [];
  const blocked: BlockedDep[] = [];

  for (const d of deps.skills) {
    const child = ctx.skillByFqn.get(d.fqn);
    if (child === undefined) {
      missing.push({ kind: "skill", name: d.fqn });
      continue;
    }
    const childStatus = computeSkillStatus(child, ctx);
    if (childStatus.status === "blocked") {
      blocked.push({ kind: "skill", fqn: child.fqn });
    }
  }
  for (const d of deps.mcps) {
    const child = ctx.mcpByFqn.get(d.fqn);
    if (child === undefined) {
      missing.push({ kind: "mcp", name: d.fqn });
    }
  }
  if (missing.length > 0) reason.missingDeps = missing;
  if (blocked.length > 0) reason.blockedDeps = blocked;

  if (Object.keys(reason).length === 0) return { status: "ready" };
  return { status: "blocked", reason: reason as BlockedReason };
}

export function computeSkillStatus(skill: Skill, ctx: CascadeContext): ComputedStatus {
  const cached = ctx.skillCache.get(skill.fqn);
  if (cached !== undefined) return cached;
  if (ctx.inFlight.has(skill.fqn)) {
    return { status: "ready" };
  }
  ctx.inFlight.add(skill.fqn);
  const result = computeWithDeps(
    {
      prereqs: skill.prereqs,
      prereqsAck: skill.prereqsAck,
      orphaned: !ctx.referencedSkillFqns.has(skill.fqn),
      disabledByUser: false,
    },
    skill.dependencies,
    ctx,
  );
  ctx.inFlight.delete(skill.fqn);
  ctx.skillCache.set(skill.fqn, result);
  return result;
}

export function computeAgentStatus(agent: Agent, ctx: CascadeContext): ComputedStatus {
  return computeWithDeps(
    {
      prereqs: agent.prereqs,
      prereqsAck: agent.prereqsAck,
      orphaned: false,
      disabledByUser: agent.disabledByUser,
    },
    agent.dependencies,
    ctx,
  );
}

export function buildSkillEntry(s: Skill, ctx: CascadeContext): SkillEntry {
  const skill = projectSkillPojo(s, ctx);
  const computed = computeSkillStatus(s, ctx);
  if (computed.status === "ready") return { skill, status: "ready" };
  const reason = computed.reason as BlockedReason;
  const out: SkillEntry = { skill, status: "blocked", blockedReason: reason };
  if (reason.missingDeps !== undefined) {
    return { ...out, missingDeps: reason.missingDeps };
  }
  return out;
}

export function buildAgentEntry(a: Agent, ctx: CascadeContext): AgentEntry {
  const agent = projectAgentPojo(a);
  const computed = computeAgentStatus(a, ctx);
  if (computed.status === "ready") return { agent, status: "ready" };
  const reason = computed.reason as BlockedReason;
  const out: AgentEntry = { agent, status: "blocked", blockedReason: reason };
  if (reason.missingDeps !== undefined) {
    return { ...out, missingDeps: reason.missingDeps };
  }
  return out;
}

export function isForeignKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.includes("FOREIGNKEY")) return true;
  return /FOREIGN\s*KEY/i.test(err.message);
}

import type { AgentEntity } from "../agent/agent-entity.js";
import type { AgentResolvedNode, AgentService } from "../agent/agent-service.js";
import type { McpEntity } from "../mcp/mcp-entity.js";
import * as McpFormat from "../mcp/mcp-format.js";
import type { McpService } from "../mcp/mcp-service.js";
import { CyclicDependencyError } from "../skill/errors.js";
import type { SkillEntity } from "../skill/skill-entity.js";
import type { SkillResolvedNode, SkillService } from "../skill/skill-service.js";
import type {
  CatalogConflict,
  CatalogPlan,
  CatalogPlanNode,
  McpResolvedNode,
  OrphanedEntry,
} from "./plan-types.js";

/**
 * Sync resolve, broken into three independently-testable phases:
 *
 * 1. {@link buildUpstreamClosure} — pure network walk, returns a
 *    `Closure` keyed by origin. Detects cycles. Knows nothing
 *    about local state.
 * 2. {@link buildLocalClosure} — pure DB walk over a seed set,
 *    returns a `Closure` of locally-installed entries. Knows
 *    nothing about upstream.
 * 3. {@link diffClosures} — pure function over the two closures,
 *    produces a `CatalogPlan` (toInstall / alreadyInstalled /
 *    identityChange / orphans).
 *
 * The facade orchestrates: phase 1 → phase 2 → phase 3. Install
 * vs sync diverge only in:
 *   - install: phase 1 may skip subtrees whose root is already
 *     installed (the existing perf optimization)
 *   - sync: phase 1 always re-fetches; phase 3 computes orphans
 *     against the global reverse-dep set
 *
 * Identity-change handling lives entirely in phase 3 — phase 1
 * walks the new upstream tree fully and phase 3 trims to "just
 * the root" when the upstream fqn differs. Slightly wasteful
 * fetch but identity changes are rare and the alternative
 * (phase 1 knowing about identity change) blurs the layering.
 */

// ─── Closure shapes ──────────────────────────────────────────

/**
 * One node in a {@link Closure}. Discriminated by `kind`; the
 * payload reuses the existing per-kind ResolvedNode shapes so
 * we don't introduce a parallel type hierarchy.
 *
 * `source` distinguishes whether this node came from upstream
 * (phase 1) or local DB (phase 2). The diff phase uses this to
 * decide which nodes need fetching/installing vs already-on-disk.
 */
export type ClosureNode =
  | { readonly kind: "skill"; readonly source: ClosureSource; readonly node: SkillResolvedNode }
  | { readonly kind: "agent"; readonly source: ClosureSource; readonly node: AgentResolvedNode }
  | { readonly kind: "mcp"; readonly source: ClosureSource; readonly node: McpResolvedNode };

export type ClosureSource = "upstream" | "local";

/**
 * Map of origin → node. A closure represents a snapshot of the
 * dep graph reachable from some root, keyed by origin (the only
 * cross-kind identifier — fqns can collide across kinds in
 * principle, origins cannot).
 */
export type Closure = ReadonlyMap<string, ClosureNode>;

// ─── Service handle (what the phases need to do their job) ───

/**
 * Bundle of services + adapters the phases need. Kept as a single
 * record so call sites pass one argument instead of N positional.
 */
export interface PipelineServices {
  readonly skill: SkillService;
  readonly agent: AgentService;
  readonly mcp: McpService;
  /** Origin → resolved MCP node (same contract as {@link McpResolveAdapter}). */
  readonly resolveMcpAdapter: (origin: string) => Promise<{
    node: McpResolvedNode | null;
    conflict: CatalogConflict | null;
  }>;
}

// ─── Phase 1: upstream closure ───────────────────────────────

export interface UpstreamClosureOptions {
  /**
   * "install" mode: when traversing a dep, if the dep is already
   * installed locally we record its local node and DO NOT fetch
   * upstream — preserves the legacy install-flow optimization
   * (avoids per-shared-dep network round-trips).
   *
   * "sync" mode: always fetch upstream for every node in the
   * closure, even if locally installed. Required so phase 3 can
   * compare versions and detect dep churn.
   */
  readonly mode: "install" | "sync";
}

export interface UpstreamClosureResult {
  readonly closure: Closure;
  readonly conflicts: readonly CatalogConflict[];
}

/**
 * Phase 1: walk the upstream graph from the root, producing a
 * closure of every reachable node.
 *
 * Cycle detection uses standard DFS coloring (inStack = GRAY,
 * visited = BLACK). Back-edge → {@link CyclicDependencyError}.
 * Diamonds (same origin via two non-overlapping paths) dedupe
 * via the visited check.
 *
 * Conflicts (fetch-failed / parse-failed / origin-conflict) are
 * collected per-origin and returned alongside the closure rather
 * than thrown — the caller can present a partial plan with errors
 * inline rather than an all-or-nothing failure.
 */
export async function buildUpstreamClosure(
  root: { kind: "skill" | "agent" | "mcp"; origin: string },
  services: PipelineServices,
  opts: UpstreamClosureOptions,
): Promise<UpstreamClosureResult> {
  const closure = new Map<string, ClosureNode>();
  const conflicts: CatalogConflict[] = [];
  const inStack = new Set<string>();
  const visited = new Set<string>();

  // Translating fqn-form dep entries back to origins for the
  // local-source closure entries built below. Preload once for cheap
  // O(1) lookup in the install-mode optimization branches.
  let cachedMaps: {
    skillOriginByFqn: Map<string, string>;
    mcpOriginByFqn: Map<string, string>;
  } | null = null;
  async function getMaps(): Promise<{
    skillOriginByFqn: Map<string, string>;
    mcpOriginByFqn: Map<string, string>;
  }> {
    if (cachedMaps !== null) return cachedMaps;
    const [skills, mcps] = await Promise.all([services.skill.list(), services.mcp.list()]);
    cachedMaps = {
      skillOriginByFqn: new Map(skills.map((s) => [s.fqn, s.origin] as const)),
      mcpOriginByFqn: new Map(mcps.map((m) => [m.fqn, m.origin] as const)),
    };
    return cachedMaps;
  }

  async function walkSkill(origin: string, isRoot: boolean): Promise<void> {
    if (inStack.has(origin)) {
      throw new CyclicDependencyError([...inStack, origin]);
    }
    if (visited.has(origin)) return;

    if (opts.mode === "install" && !isRoot) {
      const local = await services.skill.getByOrigin(origin);
      if (local !== null) {
        const maps = await getMaps();
        const anchorContent = await services.skill.getAnchor(local.fqn).catch(() => "");
        closure.set(origin, {
          kind: "skill",
          source: "local",
          node: skillEntityToResolvedNode(
            local,
            anchorContent,
            maps.skillOriginByFqn,
            maps.mcpOriginByFqn,
          ),
        });
        visited.add(origin);
        return;
      }
    }

    inStack.add(origin);
    try {
      const plan = await services.skill.resolve(origin);
      if (plan.conflict !== null) {
        conflicts.push({
          kind: "skill",
          origin: plan.conflict.origin,
          fqn: plan.conflict.fqn,
          reason: plan.conflict.reason,
        });
        return;
      }
      if (plan.node === null) return;
      for (const mcpOrigin of plan.node.depsRefs.mcps) {
        await walkMcp(mcpOrigin);
      }
      for (const skillOrigin of plan.node.depsRefs.skills) {
        await walkSkill(skillOrigin, false);
      }
      closure.set(origin, { kind: "skill", source: "upstream", node: plan.node });
    } finally {
      inStack.delete(origin);
      visited.add(origin);
    }
  }

  async function walkAgent(origin: string): Promise<void> {
    if (visited.has(origin)) return;
    const plan = await services.agent.resolve(origin);
    if (plan.conflict !== null) {
      conflicts.push({
        kind: "agent",
        origin: plan.conflict.origin,
        fqn: plan.conflict.fqn,
        reason: plan.conflict.reason,
      });
      visited.add(origin);
      return;
    }
    if (plan.node === null) {
      visited.add(origin);
      return;
    }
    for (const mcpOrigin of plan.node.depsRefs.mcps) {
      await walkMcp(mcpOrigin);
    }
    for (const skillOrigin of plan.node.depsRefs.skills) {
      await walkSkill(skillOrigin, false);
    }
    closure.set(origin, { kind: "agent", source: "upstream", node: plan.node });
    visited.add(origin);
  }

  async function walkMcp(origin: string): Promise<void> {
    if (visited.has(origin)) return;
    if (opts.mode === "install") {
      const local = await services.mcp.getByOrigin(origin);
      if (local !== null) {
        closure.set(origin, { kind: "mcp", source: "local", node: mcpEntityToResolvedNode(local) });
        visited.add(origin);
        return;
      }
    }
    const result = await services.resolveMcpAdapter(origin);
    if (result.conflict !== null) {
      conflicts.push(result.conflict);
      visited.add(origin);
      return;
    }
    if (result.node === null) {
      visited.add(origin);
      return;
    }
    closure.set(origin, { kind: "mcp", source: "upstream", node: result.node });
    visited.add(origin);
  }

  if (root.kind === "skill") {
    await walkSkill(root.origin, true);
  } else if (root.kind === "agent") {
    await walkAgent(root.origin);
  } else {
    await walkMcp(root.origin);
  }

  return { closure, conflicts };
}

// ─── Phase 2: local closure ──────────────────────────────────

/**
 * Phase 2: walk the locally-installed graph, transitively closing
 * over the deps that ARE installed. Origins that are seeded but
 * not installed locally simply don't appear in the result map
 * (no conflict generated — the local closure is a snapshot of
 * what's on disk).
 *
 * `seedOrigins` is the entry-point set; the walk transitively
 * follows `dependencies.{skills,mcps}` from each seed. For sync,
 * pass just the root origin; for install, pass the upstream
 * closure's origins (so we know which slots are already filled).
 *
 * No cycle detection here: install/sync rejects cycles upstream,
 * so the local catalog is acyclic by construction. Visited-set
 * dedupe guards against accidental loops if a bypass path
 * (direct repo write) ever produced one.
 */
export async function buildLocalClosure(
  seedOrigins: Iterable<string>,
  services: PipelineServices,
): Promise<Closure> {
  const closure = new Map<string, ClosureNode>();
  const visited = new Set<string>();
  const [skills, agents, mcps] = await Promise.all([
    services.skill.list(),
    services.agent.list(),
    services.mcp.list(),
  ]);
  const skillByOrigin = new Map(skills.map((s) => [s.origin, s] as const));
  const agentByOrigin = new Map(agents.map((a) => [a.origin, a] as const));
  const mcpByOrigin = new Map(mcps.map((m) => [m.origin, m] as const));
  // Deps are fqn-form on the entity. Build fqn → origin lookups so we
  // can translate dep fqns back to origins (the closure is keyed by
  // origin).
  const skillOriginByFqn = new Map(skills.map((s) => [s.fqn, s.origin] as const));
  const mcpOriginByFqn = new Map(mcps.map((m) => [m.fqn, m.origin] as const));

  async function visit(origin: string): Promise<void> {
    if (visited.has(origin)) return;
    visited.add(origin);

    const skill = skillByOrigin.get(origin);
    if (skill !== undefined) {
      const anchorContent = await services.skill.getAnchor(skill.fqn).catch(() => "");
      closure.set(origin, {
        kind: "skill",
        source: "local",
        node: skillEntityToResolvedNode(skill, anchorContent, skillOriginByFqn, mcpOriginByFqn),
      });
      for (const d of skill.dependencies.mcps) {
        const o = mcpOriginByFqn.get(d.fqn);
        if (o !== undefined) await visit(o);
      }
      for (const d of skill.dependencies.skills) {
        const o = skillOriginByFqn.get(d.fqn);
        if (o !== undefined) await visit(o);
      }
      return;
    }
    const agent = agentByOrigin.get(origin);
    if (agent !== undefined) {
      const anchorContent = await services.agent.getAnchor(agent.fqn).catch(() => "");
      closure.set(origin, {
        kind: "agent",
        source: "local",
        node: agentEntityToResolvedNode(agent, anchorContent, skillOriginByFqn, mcpOriginByFqn),
      });
      for (const d of agent.dependencies.mcps) {
        const o = mcpOriginByFqn.get(d.fqn);
        if (o !== undefined) await visit(o);
      }
      for (const d of agent.dependencies.skills) {
        const o = skillOriginByFqn.get(d.fqn);
        if (o !== undefined) await visit(o);
      }
      return;
    }
    const mcp = mcpByOrigin.get(origin);
    if (mcp !== undefined) {
      closure.set(origin, { kind: "mcp", source: "local", node: mcpEntityToResolvedNode(mcp) });
    }
  }

  for (const origin of seedOrigins) await visit(origin);
  return closure;
}

// ─── Phase 3: diff ───────────────────────────────────────────

export interface DiffOptions {
  readonly rootOrigin: string;
  readonly rootKind: "skill" | "agent" | "mcp";
  readonly isSync: boolean;
  /**
   * Set of every locally-installed origin (skill+agent+mcp), used
   * to filter orphan candidates: a removed dep is only an orphan
   * if NO OTHER installed entity references it. Required for sync;
   * unused for install.
   */
  readonly globalReverseDepIndex?: ReadonlySet<string>;
}

export interface DiffResult {
  readonly toInstall: readonly CatalogPlanNode[];
  readonly alreadyInstalled: readonly CatalogPlanNode[];
  readonly identityChange?: CatalogPlan["identityChange"];
  readonly orphans: readonly OrphanedEntry[];
}

/**
 * Phase 3: pure function. Compares the upstream and local
 * closures and emits the per-node disposition that drives apply.
 *
 * Identity change at root short-circuits: we emit a single
 * identity-changed root node and DROP the rest of the upstream
 * closure (its deps belong to the new identity, not the old one
 * the user is currently running). The caller is expected to
 * confirm before applying.
 *
 * Disposition rules (per non-root node, modulo identity-change):
 *   - upstream-only                              → `new`
 *   - in both, version match, fqn match          → `up-to-date`
 *   - in both, version differ                    → `will-sync`
 *   - in both, fqn differ at non-root            → not currently
 *     reachable (only root can identity-change; deps are origin-
 *     keyed so a dep's fqn changing is itself a sync-driven
 *     install of the new fqn)
 *
 * Root has one extra rule: if up-to-date but any dep ended up in
 * `toInstall` (dep churn), root is promoted to `will-sync` so the
 * user sees it as "this entry plus its deps are going to refresh".
 *
 * Orphans (sync-only): origins in local closure but NOT in upstream
 * closure, AND not referenced by any other installed entity (per
 * `globalReverseDepIndex`).
 */
export function diffClosures(upstream: Closure, local: Closure, opts: DiffOptions): DiffResult {
  // Identity change short-circuit.
  if (opts.isSync) {
    const upstreamRoot = upstream.get(opts.rootOrigin);
    const localRoot = local.get(opts.rootOrigin);
    if (
      upstreamRoot !== undefined &&
      localRoot !== undefined &&
      upstreamRoot.kind === localRoot.kind &&
      upstreamRoot.node.fqn !== localRoot.node.fqn
    ) {
      return {
        toInstall: [
          buildPlanNode(upstreamRoot, "identity-changed", true, {
            oldFqn: localRoot.node.fqn,
            newFqn: upstreamRoot.node.fqn,
          }),
        ],
        alreadyInstalled: [],
        identityChange: {
          kind: upstreamRoot.kind,
          oldFqn: localRoot.node.fqn,
          newFqn: upstreamRoot.node.fqn,
        },
        orphans: [],
      };
    }
  }

  const toInstall: CatalogPlanNode[] = [];
  const alreadyInstalled: CatalogPlanNode[] = [];

  // Walk upstream in insertion order — this is the dep-first
  // order the walkers produced, preserved so install ordering
  // (deps before parents) stays deterministic.
  for (const [origin, up] of upstream) {
    const wasAlreadyInstalled = up.source === "local" || local.has(origin);
    const localNode = local.get(origin);

    // Source = "local" means phase 1 found this origin already
    // installed and skipped the fetch. By definition unchanged.
    if (up.source === "local") {
      alreadyInstalled.push(buildPlanNode(up, undefined, true));
      continue;
    }

    // Compare upstream vs local for sync up-to-date / will-sync.
    if (localNode !== undefined && nodesAreUpToDate(up, localNode)) {
      // Up-to-date for this node. Root may still get promoted to
      // will-sync below if any dep changed.
      alreadyInstalled.push(buildPlanNode(up, "up-to-date", true));
      continue;
    }

    // Either new (no local row) or will-sync (local exists, version
    // differs).
    const disposition: "new" | "will-sync" = wasAlreadyInstalled ? "will-sync" : "new";
    toInstall.push(buildPlanNode(up, disposition, wasAlreadyInstalled));
  }

  // Root up-to-date promotion: if root landed in alreadyInstalled
  // as up-to-date but any dep is in toInstall, promote root to
  // will-sync so the on-disk view is rewritten in lockstep with
  // its deps.
  const rootIdx = alreadyInstalled.findIndex((n) => n.node.origin === opts.rootOrigin);
  if (rootIdx >= 0 && toInstall.length > 0) {
    const root = alreadyInstalled[rootIdx]!;
    if (root.disposition === "up-to-date") {
      alreadyInstalled.splice(rootIdx, 1);
      toInstall.push({ ...root, disposition: "will-sync" });
    }
  }

  // Orphan computation (sync only, root must not be mcp since
  // mcps have no transitive deps to orphan, and identity change
  // is already handled above).
  const orphans: OrphanedEntry[] = [];
  if (opts.isSync && opts.rootKind !== "mcp" && opts.globalReverseDepIndex !== undefined) {
    for (const [origin, localNode] of local) {
      if (origin === opts.rootOrigin) continue;
      if (upstream.has(origin)) continue;
      // origin is in local closure but no longer in upstream —
      // candidate for orphan iff nothing else references it.
      if (opts.globalReverseDepIndex.has(origin)) continue;
      if (localNode.kind === "agent") continue; // agents are roots, never orphan
      orphans.push({
        kind: localNode.kind,
        fqn: localNode.node.fqn,
        origin,
      });
    }
  }

  return {
    toInstall,
    alreadyInstalled,
    orphans,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function buildPlanNode(
  entry: ClosureNode,
  disposition: CatalogPlanNode["disposition"],
  wasAlreadyInstalled: boolean,
  identityChange?: { oldFqn: string; newFqn: string },
): CatalogPlanNode {
  const base = {
    ...(wasAlreadyInstalled ? { wasAlreadyInstalled: true } : {}),
    ...(disposition !== undefined ? { disposition } : {}),
    ...(identityChange !== undefined ? { identityChange } : {}),
  } as const;
  if (entry.kind === "skill") return { kind: "skill", node: entry.node, ...base };
  if (entry.kind === "agent") return { kind: "agent", node: entry.node, ...base };
  return { kind: "mcp", node: entry.node, ...base };
}

function nodesAreUpToDate(a: ClosureNode, b: ClosureNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.node.fqn !== b.node.fqn) return false;
  if (a.kind === "mcp" && b.kind === "mcp") {
    // MCPs don't have a `version` field — the author contract for
    // "did anything change" is the file content itself. We strip
    // `_meta` before hashing because emploke stamps `_meta.name` on
    // every install (and registry tooling may add other sub-objects);
    // those install-time additions would otherwise show as spurious
    // diffs against pristine upstream bytes.
    const localDigest = McpFormat.contentDigestExcludingMeta(a.node.content, `local:${a.node.fqn}`);
    const upstreamDigest = McpFormat.contentDigestExcludingMeta(
      b.node.content,
      `upstream:${b.node.fqn}`,
    );
    if (localDigest === null || upstreamDigest === null) return false;
    return localDigest === upstreamDigest;
  }
  if (a.kind === "mcp" || b.kind === "mcp") return false; // type-narrowing safety
  return a.node.version === b.node.version;
}

function skillEntityToResolvedNode(
  s: SkillEntity,
  anchorContent: string,
  skillOriginByFqn: ReadonlyMap<string, string>,
  mcpOriginByFqn: ReadonlyMap<string, string>,
): SkillResolvedNode {
  return {
    fqn: s.fqn,
    origin: s.origin,
    anchorContent,
    version: s.version,
    depsRefs: {
      skills: s.dependencies.skills.map((d) => skillOriginByFqn.get(d.fqn) ?? "").filter(Boolean),
      mcps: s.dependencies.mcps.map((d) => mcpOriginByFqn.get(d.fqn) ?? "").filter(Boolean),
    },
  };
}

function agentEntityToResolvedNode(
  a: AgentEntity,
  anchorContent: string,
  skillOriginByFqn: ReadonlyMap<string, string>,
  mcpOriginByFqn: ReadonlyMap<string, string>,
): AgentResolvedNode {
  return {
    fqn: a.fqn,
    origin: a.origin,
    anchorContent,
    version: a.version,
    depsRefs: {
      skills: a.dependencies.skills.map((d) => skillOriginByFqn.get(d.fqn) ?? "").filter(Boolean),
      mcps: a.dependencies.mcps.map((d) => mcpOriginByFqn.get(d.fqn) ?? "").filter(Boolean),
    },
  };
}

function mcpEntityToResolvedNode(m: McpEntity): McpResolvedNode {
  return {
    fqn: m.fqn,
    origin: m.origin,
    content: m.spec,
  };
}

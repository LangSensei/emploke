import { randomUUID } from "node:crypto";
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
  BlockedDep,
  BlockedReason,
  EntryStatus,
  InstallEntryOpts,
  InstallMcpOpts,
  McpMetadata,
  MissingDep,
  ResolvedMcp,
  ResolvedSkill,
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
import {
  buildLocalClosure,
  buildUpstreamClosure,
  diffClosures,
  type PipelineServices,
} from "./resolve-pipeline.js";

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
 * Backing store: SQLite (one `catalog.db` per workspace, opened by the
 * per-entity repositories in WAL mode). The facade holds no in-memory
 * snapshot — every read goes straight to the repos and runs in
 * autocommit, so each call starts a fresh implicit read transaction
 * that observes any commit from another `CatalogManager` instance in
 * the same process or from a separate SQLite-aware writer holding its
 * own connection to the same file. (External tools that *replace* the
 * `catalog.db` file out-of-band — e.g. `git pull` overwriting it
 * while a handle is open — are unsupported; SQLite's WAL invariants
 * assume the file is only mutated through SQLite.) Status-aware list
 * operations (e.g. `listSkillEntries`) batch the underlying SELECTs
 * with `Promise.all` to keep the wall-clock cost flat.
 *
 * Identity vocabulary recap:
 *   - skill / agent: `fqn` (`<scope>/<shortName>`) is the local
 *     namespace key; `origin` is the install-source URI.
 *   - mcp: `name` (`<namespace>/<short>`) is the spec FQN; emploke
 *     uses it as the local key without an extra scope segment.
 */

// ─── Plan shape ─────────────────────────────────────────────

/**
 * Tag describing the disposition of a node in a sync resolve plan.
 *
 *  - `new`              — fresh install; no local row at this origin
 *  - `will-sync`        — local row exists; upstream changed; will overwrite
 *  - `up-to-date`       — local row exists; upstream identical (skipped)
 *  - `identity-changed` — root only; upstream `fqn` differs from local
 *  - `removed`          — sync-only; this dep was previously referenced
 *                         but isn't anymore (orphan candidate)
 */
export type PlanNodeDisposition =
  | "new"
  | "will-sync"
  | "up-to-date"
  | "identity-changed"
  | "removed";

export type CatalogPlanNode =
  | {
      kind: "mcp";
      node: McpResolvedNode;
      wasAlreadyInstalled?: boolean;
      disposition?: PlanNodeDisposition;
      identityChange?: { oldFqn: string; newFqn: string };
    }
  | {
      kind: "skill";
      node: SkillResolvedNode;
      wasAlreadyInstalled?: boolean;
      disposition?: PlanNodeDisposition;
      identityChange?: { oldFqn: string; newFqn: string };
    }
  | {
      kind: "agent";
      node: AgentResolvedNode;
      wasAlreadyInstalled?: boolean;
      disposition?: PlanNodeDisposition;
      identityChange?: { oldFqn: string; newFqn: string };
    };

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

/**
 * One entry that the sync would orphan (the previously-referenced dep
 * isn't in the new closure, and no other installed entity references it).
 *
 * `orphans` always carries entries already present in the local catalog
 * — this is the diff payload, not a fetch plan.
 */
export interface OrphanedEntry {
  readonly kind: "skill" | "mcp";
  readonly fqn: string;
  readonly origin: string;
}

export interface CatalogPlan {
  readonly toInstall: readonly CatalogPlanNode[];
  readonly alreadyInstalled: readonly CatalogPlanNode[];
  readonly conflicts: readonly CatalogConflict[];
  /**
   * The origin URI that drives this plan — the user-requested install
   * origin (for `resolveSkill` / `resolveAgent` / `resolveMcp`) or the
   * local row's origin (for `resolveSync*`). Always populated so the
   * server's manifest projection can identify the "root" node without
   * a second catalog lookup.
   */
  readonly rootOrigin: string;
  /** True iff this plan was produced via a sync resolve (not a fresh install). */
  readonly isSync: boolean;
  /** Populated on sync-resolve when the upstream `fqn` differs from local. */
  readonly identityChange?: { kind: "skill" | "agent" | "mcp"; oldFqn: string; newFqn: string };
  /** Sync-only: deps the new closure dropped that have no remaining reverse-deps. */
  readonly orphans: readonly OrphanedEntry[];
  /** True iff every node short-circuits to `up-to-date` and there are no orphans. */
  readonly upToDate: boolean;
}

/**
 * One row inside {@link CatalogInstallResult.installed}. The base info
 * (`kind` + `fqn`) is always present; for skill / agent installs we
 * also surface the post-install `prereqs` text and `prereqsAck` flag
 * so callers (HTTP clients, dashboard) can prompt the user to set up
 * and acknowledge prereqs without making a follow-up GET.
 *
 * Conventions:
 *  - `prereqs` is omitted when the entry has no non-empty prereqs.
 *  - `prereqsAck` is omitted for mcps (mcps have no prereqs concept).
 *  - For skills/agents without prereqs, `prereqsAck` is `true`
 *    (nothing to acknowledge).
 *  - For skills/agents WITH prereqs:
 *      - fresh install        → `prereqs` set, `prereqsAck = false`
 *      - sync, text unchanged → `prereqs` set, `prereqsAck = true`  (preserved)
 *      - sync, text changed   → `prereqs` set, `prereqsAck = false` (reset)
 *
 * Frontend rule: `if (entry.prereqs && entry.prereqsAck === false) prompt`.
 */
export interface CatalogInstalledEntry {
  readonly kind: "mcp" | "skill" | "agent";
  readonly fqn: string;
  readonly prereqs?: string;
  readonly prereqsAck?: boolean;
}

/**
 * Per-entity result row inside {@link CatalogInstallResult.failed}.
 * `error` is a wire-safe `{ name, message }` projection — `Error`
 * instances would lose their non-enumerable `name`/`message`/`stack`
 * properties through `JSON.stringify`, leaving callers with `{}`.
 *
 * Callers that need the original `Error` instance should drive
 * `install()` themselves and inspect the thrown error from `installNode`
 * — the in-memory shim methods (`installSkillFromOrigin` etc.) keep
 * the throw path for exactly that reason.
 */
export interface CatalogInstallFailure {
  readonly kind: "mcp" | "skill" | "agent";
  readonly fqn: string;
  readonly error: { readonly name: string; readonly message: string };
}

export interface CatalogInstallSkip {
  readonly kind: "mcp" | "skill" | "agent";
  readonly fqn: string;
  /**
   * Why this node didn't run an install.
   *  - `already-installed`: dep already present locally; we didn't
   *    re-fetch (non-sync flow).
   *  - `dep-failed`: a transitive dep this node depends on failed —
   *    poison propagation.
   *  - `up-to-date`: SYNC ONLY — fqn+version+content match upstream.
   *    Never produced by the install path; only `applySync` emits it.
   */
  readonly reason: "already-installed" | "dep-failed" | "up-to-date";
}

export interface CatalogInstallResult {
  readonly installed: readonly CatalogInstalledEntry[];
  readonly skipped: readonly CatalogInstallSkip[];
  readonly failed: readonly CatalogInstallFailure[];
}

/**
 * Returned by {@link CatalogManager.applySync}. Extends
 * {@link CatalogInstallResult} with the orphan-diff payload — these
 * two only ever co-occur (install never produces orphans), so we keep
 * the install response narrow and add the sync-specific data here.
 */
export interface CatalogSyncResult extends CatalogInstallResult {
  readonly orphansFlagged: readonly OrphanedEntry[];
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

/**
 * Single entry in {@link CatalogManager}'s plan token cache. Holds the
 * `CatalogPlan` produced by a `resolveSync*` call and an absolute
 * expiry timestamp. The cache is the binding between the dashboard's
 * preview-then-apply two-step UX and the server's apply path: the
 * dashboard receives a token from `/sync/resolve`, ships it back on
 * `/sync`, and the server replays the exact preview-time plan instead
 * of re-resolving (which would discard the user's previewed manifest).
 */
interface CachedPlan {
  readonly plan: CatalogPlan;
  /** Epoch ms; entries past this are evicted on next `cachePlan` call. */
  readonly expiresAt: number;
}

/**
 * TTL for cached resolve plans, in milliseconds. Picked to be short
 * enough that abandoned previews don't accumulate (single-user local
 * server), long enough for the user to read the preview and confirm.
 */
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class CatalogManager {
  /**
   * Single-use plan cache for the preview/apply UX. See {@link
   * CachedPlan}. Lazy-evicted on every `cachePlan` write, no
   * background interval — the cache stays small in practice and the
   * eviction sweep is O(n) where n is "in-flight previews", typically
   * < 5 for a single user.
   */
  private readonly planCache = new Map<string, CachedPlan>();

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
        // Stamp our `name` onto _meta so downstream consumers see a
        // consistent fqn regardless of what the upstream file
        // declared. Origin is NOT stamped — it lives on the SQLite
        // row, not in the file (any pre-existing `_meta.origin` is
        // preserved as foreign data but never read).
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

    return new CatalogManager(mcpSvc, skillSvc, agentSvc, resolveMcp);
  }

  // ─── Lifecycle ────────────────────────────────────────

  close(): void {
    this.skill.close();
    this.agent.close();
    this.mcp.close();
  }

  // ─── Resolve (cross-entity walk) ──────────────────────

  async resolveSkill(origin: string): Promise<CatalogPlan> {
    return this.runResolvePipeline({ kind: "skill", origin }, false);
  }

  async resolveAgentFromOrigin(origin: string): Promise<CatalogPlan> {
    return this.runResolvePipeline({ kind: "agent", origin }, false);
  }

  async resolveMcp(origin: string): Promise<CatalogPlan> {
    return this.runResolvePipeline({ kind: "mcp", origin }, false);
  }

  // ─── Sync resolve / apply ─────────────────────────────

  /**
   * Cache a freshly-resolved plan and return a single-use token. The
   * dashboard's preview-then-apply flow ships this token back on
   * `/sync` so the server can replay the exact preview-time plan
   * instead of re-resolving (which would discard the user's
   * previewed manifest and silently apply a fresh — potentially
   * different — closure).
   *
   * Single-use: {@link takePlan} deletes on read so a double-click
   * Apply can't re-run the install. The dashboard can request a
   * fresh preview if it needs to retry.
   *
   * Eviction is lazy (runs here on every cache write). For a
   * single-user local server the cache stays small (≤ ~5 in-flight
   * previews), so the O(n) sweep is negligible.
   */
  cachePlan(plan: CatalogPlan): string {
    this.evictExpiredPlans();
    const token = randomUUID();
    this.planCache.set(token, { plan, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
    return token;
  }

  /**
   * Trade a token issued by {@link cachePlan} for the original plan.
   * Returns `null` if the token is unknown, already taken, or
   * expired — callers should map that to a 410 Gone with a "preview
   * expired, please re-preview" message so the user knows to rerun
   * the resolve step.
   *
   * Single-use: deletes the entry on read regardless of expiry,
   * preventing double-apply on UI double-click.
   */
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

  /**
   * Sync resolve: compute the install delta for an already-installed
   * skill, plus the dep diff (orphans) and identity-change check.
   *
   * Differences from {@link resolveSkill}:
   *   - input is the local fqn (origin is read from the row)
   *   - the manifest carries `isSync = true`
   *   - on identity change (upstream fqn ≠ local fqn) the walk emits a
   *     single root node tagged `identity-changed` and stops there;
   *     dep walk is deferred until the user confirms
   *   - on no upstream change AND no orphans, the manifest's `upToDate`
   *     is `true` and apply is a no-op
   *   - removed deps appear in `orphans` (not `nodes`) so existing
   *     ResolveTree renderers don't need a special case
   */
  async resolveSyncSkill(fqn: string): Promise<CatalogPlan> {
    const local = await this.skill.get(fqn);
    if (local === null) throw new SkillNotFoundError(fqn);
    return this.runResolvePipeline({ kind: "skill", origin: local.origin }, true);
  }

  async resolveSyncAgent(fqn: string): Promise<CatalogPlan> {
    const local = await this.agent.get(fqn);
    if (local === null) throw new AgentNotFoundError(fqn);
    return this.runResolvePipeline({ kind: "agent", origin: local.origin }, true);
  }

  async resolveSyncMcp(name: string): Promise<CatalogPlan> {
    const local = await this.mcp.get(name);
    if (local === null) throw new McpNotFoundError(name);
    return this.runResolvePipeline({ kind: "mcp", origin: local.origin }, true);
  }

  /**
   * Drive the 3-phase pipeline (see {@link resolve-pipeline.ts}) and
   * project the result back into a {@link CatalogPlan}.
   *
   * Both install (`isSync=false`) and sync (`isSync=true`) flows
   * use the same pipeline; the only differences are:
   *   - install mode lets phase 1 skip fetching deps that are
   *     already installed locally (preserves the legacy perf
   *     optimization)
   *   - sync mode threads a global reverse-dep index into phase 3
   *     so orphan candidates can be filtered against "is anything
   *     else still pointing at this dep?"
   */
  private async runResolvePipeline(
    root: { kind: "skill" | "agent" | "mcp"; origin: string },
    isSync: boolean,
  ): Promise<CatalogPlan> {
    const services: PipelineServices = {
      skill: this.skill,
      agent: this.agent,
      mcp: this.mcp,
      resolveMcpAdapter: this.resolveMcpAdapter,
    };
    const upstream = await buildUpstreamClosure(root, services, {
      mode: isSync ? "sync" : "install",
    });
    const local = await buildLocalClosure([root.origin], services);
    // Sync orphan filtering needs the global reverse-dep index —
    // a removed dep is only an orphan when NO OTHER installed
    // entity still references it. Computed once here from a
    // single sweep over all installed skills + agents.
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
      toInstall: diff.toInstall,
      alreadyInstalled: diff.alreadyInstalled,
      conflicts: upstream.conflicts,
      rootOrigin: root.origin,
      isSync,
      ...(diff.identityChange !== undefined ? { identityChange: diff.identityChange } : {}),
      orphans: diff.orphans,
      upToDate,
    };
  }

  /**
   * Build the global reverse-dep index used by the diff phase to
   * filter orphan candidates. An origin is in the set iff at least
   * one installed entity (skill or agent) OTHER THAN the root lists
   * it in its `dependencies.{skills,mcps}` array.
   *
   * The root MUST be excluded — otherwise the root's own dropped
   * deps would never qualify as orphans (root just removed them
   * from upstream but its OLD local row still references them
   * until applySync rewrites it).
   *
   * No self-reference filter is needed: install/sync rejects cycles
   * (the simplest cycle being a self-loop) at resolve time via
   * {@link CyclicDependencyError}, so a self-referencing skill
   * cannot exist in a well-formed catalog. If a bypass path
   * (direct repo write, FS edit) ever produces one, the right fix
   * is a catalog-load integrity check, not patching every consumer
   * of the dep graph.
   */
  private async computeReverseDepIndex(rootOrigin: string): Promise<Set<string>> {
    const [skills, agents] = await Promise.all([this.skill.list(), this.agent.list()]);
    const referenced = new Set<string>();
    for (const a of agents) {
      if (a.origin === rootOrigin) continue;
      for (const o of a.dependencies.skills) referenced.add(o);
      for (const o of a.dependencies.mcps) referenced.add(o);
    }
    for (const s of skills) {
      if (s.origin === rootOrigin) continue;
      for (const o of s.dependencies.skills) referenced.add(o);
      for (const o of s.dependencies.mcps) referenced.add(o);
    }
    return referenced;
  }

  /**
   * Apply a sync plan: run the regular install pass.
   *
   * For an `identity-changed` plan, deletes the old fqn row before
   * the new install runs.
   *
   * **Known limitation — not atomic across delete + install.** The
   * delete commits before the install fetches the upstream tree. If
   * the install fails mid-flight (network blip, parse error, or a
   * pre-existing entry collision at the new fqn), the old row is
   * gone and the new one never lands. We accept this tradeoff
   * because in practice:
   *   - the delete and install hit the same origin within a few ms
   *     of each other; the install's fetchTree almost always
   *     succeeds when the resolve's fetchAnchor just succeeded
   *   - emploke entries are local mirrors of upstream — recovery is
   *     a one-shot `installSkill(origin)` away (the only thing that
   *     leaks is per-installation flags like `prereqsAck`, which
   *     the user can re-acknowledge)
   *   - making it actually atomic requires either fetch-first-into-
   *     memory (~80 lines, restructures the install path) or a
   *     SQLite write transaction spanning network I/O (holds the
   *     workspace's write lock across `fetchTree`, regressing other
   *     writers' latency).
   * If a real-world report of data loss surfaces, revisit; until
   * then the code-comment is the documentation.
   *
   * Orphan handling: `plan.orphans` is informational — sync no longer
   * sets a persisted `orphaned` flag on dropped deps. Orphan status is
   * derived live from the catalog dep graph at projection time
   * (`projectSkillPojo`, `projectMcpPojo`), so any entry that lost its
   * last reverse-dep — whether through a sync diff, an explicit
   * `removeAgent`, or an edit that drops a dep — is automatically
   * reflected in subsequent reads. The list is still returned in
   * `orphansFlagged` so the dashboard's sync preview can highlight
   * "FYI, these went orphan because of this sync".
   */
  async applySync(plan: CatalogPlan): Promise<CatalogSyncResult> {
    if (plan.identityChange !== undefined) {
      const ic = plan.identityChange;
      // Non-atomic with the install below — see jsdoc above for the
      // known data-loss window and why we accept it.
      if (ic.kind === "skill") await this.skill.delete(ic.oldFqn);
      else if (ic.kind === "agent") await this.agent.delete(ic.oldFqn);
      else await this.mcp.delete(ic.oldFqn);
    }
    const result = await this.install(plan);
    return { ...result, orphansFlagged: plan.orphans };
  }

  // ─── Enable / disable / acknowledge (per-entry flags) ──────────

  /** Acknowledge the prereqs of a skill. Idempotent. */
  async acknowledgeSkillPrereqs(fqn: string): Promise<SkillPojo> {
    const updated = await this.skill.acknowledgePrereqs(fqn);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  /** Acknowledge the prereqs of an agent. Idempotent. */
  async acknowledgeAgentPrereqs(fqn: string): Promise<AgentPojo> {
    const updated = await this.agent.acknowledgePrereqs(fqn);
    return projectAgentPojo(updated);
  }

  /**
   * Flip an agent's `disabled_by_user` flag to `true`. Skills cannot
   * be user-disabled (use `delete` or edit deps instead).
   */
  async disableAgent(fqn: string): Promise<AgentPojo> {
    const updated = await this.agent.disableByUser(fqn);
    return projectAgentPojo(updated);
  }

  /** Flip an agent's `disabled_by_user` flag to `false`. */
  async enableAgent(fqn: string): Promise<AgentPojo> {
    const updated = await this.agent.enableByUser(fqn);
    return projectAgentPojo(updated);
  }

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

    const poisoned = new Set<string>(); // keyed by origin
    const depsByOrigin = new Map<string, string[]>();
    for (const planNode of plan.toInstall) {
      depsByOrigin.set(planNode.node.origin, planRefs(planNode));
    }

    for (const planNode of plan.toInstall) {
      const fqn = planNode.node.fqn;
      const origin = planNode.node.origin;
      // up-to-date nodes never appear in toInstall (they go to
      // alreadyInstalled), so we don't need a special case here.
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
    if (result.failed.length > 0) {
      const first = result.failed[0]!;
      throw new Error(`${first.error.name}: ${first.error.message}`);
    }
    const installed = await this.skill.getByOrigin(origin);
    if (installed === null) {
      throw new Error(`installSkillFromOrigin: no entity persisted for ${origin}`);
    }
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(installed, ctx);
  }

  async installAgentFromOrigin(origin: string, _opts: InstallEntryOpts = {}): Promise<AgentPojo> {
    const plan = await this.resolveAgentFromOrigin(origin);
    const result = await this.install(plan);
    if (plan.conflicts.length > 0 && plan.toInstall.length === 0) {
      throw conflictToError(plan.conflicts[0] as CatalogConflict);
    }
    if (result.failed.length > 0) {
      const first = result.failed[0]!;
      throw new Error(`${first.error.name}: ${first.error.message}`);
    }
    const installed = await this.agent.getByOrigin(origin);
    if (installed === null) {
      throw new Error(`installAgentFromOrigin: no entity persisted for ${origin}`);
    }
    return projectAgentPojo(installed);
  }

  async installMcp(content: string, opts: InstallMcpOpts): Promise<string> {
    const entity = await this.mcp.install(opts.name, opts.origin, content);
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

  async listSkillEntries(): Promise<SkillEntry[]> {
    const ctx = await this.loadCascadeContext();
    return [...ctx.skillByOrigin.values()].map((s) => buildSkillEntry(s, ctx));
  }

  async listAgentEntries(): Promise<AgentEntry[]> {
    const [agents, ctx] = await Promise.all([this.agent.list(), this.loadCascadeContext()]);
    return agents.map((a) => buildAgentEntry(a, ctx));
  }

  async listMcps(): Promise<McpMetadata[]> {
    const ctx = await this.loadCascadeContext();
    return [...ctx.mcpByOrigin.values()].map((m) => projectMcpMetadata(m, ctx));
  }
  async listSkills(): Promise<SkillPojo[]> {
    const ctx = await this.loadCascadeContext();
    return [...ctx.skillByOrigin.values()].map((s) => projectSkillPojo(s, ctx));
  }
  async listAgents(): Promise<AgentPojo[]> {
    const agents = await this.agent.list();
    return agents.map((a) => projectAgentPojo(a));
  }

  async getSkillEntry(fqn: string): Promise<SkillEntry | null> {
    const s = await this.skill.get(fqn);
    if (s === null) return null;
    const ctx = await this.loadCascadeContext();
    return buildSkillEntry(s, ctx);
  }

  async getAgentEntry(fqn: string): Promise<AgentEntry | null> {
    const a = await this.agent.get(fqn);
    if (a === null) return null;
    const ctx = await this.loadCascadeContext();
    return buildAgentEntry(a, ctx);
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

  // ─── Async POJO read accessors ──

  async getSkill(fqn: string): Promise<SkillPojo | null> {
    const s = await this.skill.get(fqn);
    if (s === null) return null;
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(s, ctx);
  }

  async getAgent(fqn: string): Promise<AgentPojo | null> {
    const a = await this.agent.get(fqn);
    if (a === null) return null;
    return projectAgentPojo(a);
  }

  async getMcp(name: string): Promise<McpMetadata | null> {
    const m = await this.mcp.get(name);
    if (m === null) return null;
    const ctx = await this.loadCascadeContext();
    return projectMcpMetadata(m, ctx);
  }

  // ─── Mutations: legacy compat API ──

  async updateSkillContent(fqn: string, content: string): Promise<SkillPojo> {
    const updated = await this.skill.updateAnchor(fqn, content);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  async updateAgentContent(fqn: string, content: string): Promise<AgentPojo> {
    const updated = await this.agent.updateAnchor(fqn, content);
    return projectAgentPojo(updated);
  }

  async updateMcpContent(name: string, content: string): Promise<void> {
    await this.mcp.updateContent(name, content);
  }

  async updateSkillMetadata(fqn: string, patch: SkillMetadataPatch): Promise<SkillPojo> {
    const updated = await this.skill.updateMetadata(fqn, patch as Record<string, unknown>);
    const ctx = await this.loadCascadeContext();
    return projectSkillPojo(updated, ctx);
  }

  async updateAgentMetadata(fqn: string, patch: AgentMetadataPatch): Promise<AgentPojo> {
    const updated = await this.agent.updateMetadata(fqn, patch as Record<string, unknown>);
    return projectAgentPojo(updated);
  }

  async removeSkill(fqn: string): Promise<void> {
    await this.deleteSkill(fqn);
  }

  async removeAgent(fqn: string): Promise<void> {
    await this.deleteAgent(fqn);
  }

  async removeMcp(name: string): Promise<void> {
    await this.deleteMcp(name);
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
  // agent: no network, just SQLite reads. Used by the runtime when
  // materialising a session workdir.
  //
  // Skills/mcps in the dep graph are looked up by origin (since dep
  // refs are origin-only). One SELECT per kind, then in-process
  // `Map.get(origin)` walks the dep DAG — no per-dep round trip.

  async resolveAgent(fqn: string): Promise<AgentResolveResult> {
    const [agents, skills, mcps] = await Promise.all([
      this.agent.list(),
      this.skill.list(),
      this.mcp.list(),
    ]);
    const agent = agents.find((a) => a.fqn === fqn);
    if (agent === undefined) throw new AgentNotFoundError(fqn);

    const ctx = newCascadeContext(skills, agents, mcps);

    const visited = new Set<string>();
    const orderedSkills: Skill[] = [];
    const mcpFqns = new Set<string>();

    const walk = (skillOrigins: readonly string[], mcpOrigins: readonly string[]): void => {
      for (const o of mcpOrigins) {
        const m = ctx.mcpByOrigin.get(o);
        if (m !== undefined) mcpFqns.add(m.name);
      }
      for (const o of skillOrigins) {
        if (visited.has(o)) continue;
        visited.add(o);
        const skill = ctx.skillByOrigin.get(o);
        if (skill === undefined) continue;
        walk(skill.dependencies.skills, skill.dependencies.mcps);
        orderedSkills.push(skill);
      }
    };

    walk(agent.dependencies.skills, agent.dependencies.mcps);

    return {
      agent: projectAgentPojo(agent),
      skills: orderedSkills.map((s) => ({ skill: projectSkillPojo(s, ctx) })),
      mcps: [...mcpFqns].map((name) => ({ name })),
    };
  }

  async resolveSkillFromCatalog(fqn: string): Promise<SkillResolveResult> {
    const [skills, agents, mcps] = await Promise.all([
      this.skill.list(),
      this.agent.list(),
      this.mcp.list(),
    ]);
    const root = skills.find((s) => s.fqn === fqn);
    if (root === undefined) throw new SkillNotFoundError(fqn);
    const ctx = newCascadeContext(skills, agents, mcps);
    const visited = new Set<string>();
    const ordered: Skill[] = [];
    const mcpFqns = new Set<string>();

    const walk = (origin: string): void => {
      if (visited.has(origin)) return;
      visited.add(origin);
      const skill = ctx.skillByOrigin.get(origin);
      if (skill === undefined) return;
      for (const o of skill.dependencies.mcps) {
        const m = ctx.mcpByOrigin.get(o);
        if (m !== undefined) mcpFqns.add(m.name);
      }
      for (const o of skill.dependencies.skills) walk(o);
      ordered.push(skill);
    };
    walk(root.origin);

    return {
      skill: projectSkillPojo(root, ctx),
      skills: ordered.map((s) => ({ skill: projectSkillPojo(s, ctx) })),
      mcps: [...mcpFqns].map((name) => ({ name })),
    };
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
  }

  async deleteSkill(fqn: string): Promise<void> {
    const dependents = await this.findSkillDependents(fqn);
    if (dependents.length > 0) throw new HasDependentsError(fqn, dependents);
    await this.skill.delete(fqn);
  }

  async deleteMcp(name: string): Promise<void> {
    const dependents = await this.findMcpDependents(name);
    if (dependents.length > 0) throw new HasDependentsError(name, dependents);
    await this.mcp.delete(name);
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

  private async installNode(planNode: CatalogPlanNode): Promise<Skill | Agent | Mcp> {
    if (planNode.kind === "skill") {
      return this.skill.install(planNode.node);
    }
    if (planNode.kind === "agent") {
      return this.agent.install(planNode.node);
    }
    return this.mcp.install(planNode.node.fqn, planNode.node.origin, planNode.node.content);
  }

  /**
   * Load every installed entity and bundle them into a {@link
   * CascadeContext} for status / orphan derivation. Used by every
   * facade method that needs to project a wire DTO carrying derived
   * `orphaned`. Three full-list reads (skills, agents, mcps) — at
   * catalog scale (<100 entries) the cost is negligible and well
   * below the price of the SQL round-trip we'd need to maintain a
   * normalised dep table on every write instead.
   */
  private async loadCascadeContext(): Promise<CascadeContext> {
    const [skills, agents, mcps] = await Promise.all([
      this.skill.list(),
      this.agent.list(),
      this.mcp.list(),
    ]);
    return newCascadeContext(skills, agents, mcps);
  }
}

// ─── Helpers ────────────────────────────────────────────────

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

function projectSkillPojo(s: Skill, ctx: CascadeContext): SkillPojo {
  return {
    ...(s.toJSON() as object),
    mutable: isOriginMutable(s.origin),
    orphaned: !ctx.referencedSkillOrigins.has(s.origin),
  } as unknown as SkillPojo;
}

function projectAgentPojo(a: Agent): AgentPojo {
  return {
    ...(a.toJSON() as object),
    mutable: isOriginMutable(a.origin),
  } as unknown as AgentPojo;
}

function projectMcpMetadata(m: Mcp, ctx: CascadeContext): McpMetadata {
  return {
    ...(m.toJSON() as object),
    mutable: isOriginMutable(m.origin),
    orphaned: !ctx.referencedMcpOrigins.has(m.origin),
  } as unknown as McpMetadata;
}

/**
 * Per-list cascade-status context. Built once per `listSkillEntries` /
 * `listAgentEntries` call; the recursive `computeEntry` walks the
 * in-memory dep graph with memoisation, so each entity's status is
 * computed at most once even with extensive cross-references.
 *
 * Also carries the reverse-dep index (`referenced{Skill,Mcp}Origins`)
 * so derived `orphaned` can be projected with a single `Set.has` per
 * entity at no extra cost — both status and orphan share the same
 * single in-memory walk.
 */
interface CascadeContext {
  readonly skillByOrigin: ReadonlyMap<string, Skill>;
  readonly mcpByOrigin: ReadonlyMap<string, Mcp>;
  readonly mcpByName: ReadonlyMap<string, Mcp>;
  readonly skillCache: Map<string, ComputedStatus>;
  /** Origins currently being computed — used to defensively short-circuit cycles. */
  readonly inFlight: Set<string>;
  /**
   * Set of skill origins referenced by at least one installed agent or
   * skill. Membership ↔ "has a reverse-dep" ↔ "not orphan". Built
   * once at ctx-construction time from the agents+skills lists.
   */
  readonly referencedSkillOrigins: ReadonlySet<string>;
  /** Same as {@link referencedSkillOrigins}, but for mcp dep refs. */
  readonly referencedMcpOrigins: ReadonlySet<string>;
}

interface ComputedStatus {
  readonly status: EntryStatus;
  readonly reason?: BlockedReason;
}

function newCascadeContext(skills: Skill[], agents: Agent[], mcps: Mcp[]): CascadeContext {
  const referencedSkillOrigins = new Set<string>();
  const referencedMcpOrigins = new Set<string>();
  for (const a of agents) {
    for (const o of a.dependencies.skills) referencedSkillOrigins.add(o);
    for (const o of a.dependencies.mcps) referencedMcpOrigins.add(o);
  }
  for (const s of skills) {
    // No self-reference filter: install/sync rejects cycles (the
    // simplest cycle being a self-loop) at resolve time via
    // CyclicDependencyError, so a self-referencing skill cannot
    // exist in a well-formed catalog. The orphan badge stays
    // correct because the cycle never makes it into the catalog
    // in the first place.
    for (const o of s.dependencies.skills) referencedSkillOrigins.add(o);
    for (const o of s.dependencies.mcps) referencedMcpOrigins.add(o);
  }
  return {
    skillByOrigin: new Map(skills.map((s) => [s.origin, s] as const)),
    mcpByOrigin: new Map(mcps.map((m) => [m.origin, m] as const)),
    mcpByName: new Map(mcps.map((m) => [m.name, m] as const)),
    skillCache: new Map(),
    inFlight: new Set(),
    referencedSkillOrigins,
    referencedMcpOrigins,
  };
}

function computeSkillStatus(skill: Skill, ctx: CascadeContext): ComputedStatus {
  const cached = ctx.skillCache.get(skill.origin);
  if (cached !== undefined) return cached;
  if (ctx.inFlight.has(skill.origin)) {
    // Defensive only: install/sync now reject cyclic dep graphs at
    // resolve time (see `walkSkill` + `CyclicDependencyError`), so
    // a well-formed catalog should never bottom out here. Kept as
    // a safe fallback for two reasons:
    //   1. Bypassed install paths (direct repo writes, FS edits,
    //      future tools) could leave a cycle on disk.
    //   2. Without the short-circuit a cycle would infinite-recurse.
    // The "ready" answer here only suppresses the cycle-internal
    // cascade contribution; the outer call still factors its own
    // self-causes correctly. The cached result (set below after
    // the recursive call returns) is therefore self-consistent for
    // any non-cyclic caller; cyclic callers see the same defensive
    // ready value as the inner call would.
    return { status: "ready" };
  }
  ctx.inFlight.add(skill.origin);
  const result = computeWithDeps(
    {
      prereqs: skill.prereqs,
      prereqsAck: skill.prereqsAck,
      // Derived live from the dep graph: a skill with zero reverse-deps
      // (excluding self-references) is orphan. No more stale-flag
      // scenarios — the answer is always a fact about the current
      // catalog state.
      orphaned: !ctx.referencedSkillOrigins.has(skill.origin),
      disabledByUser: false,
    },
    skill.dependencies,
    ctx,
  );
  ctx.inFlight.delete(skill.origin);
  ctx.skillCache.set(skill.origin, result);
  return result;
}

function computeAgentStatus(agent: Agent, ctx: CascadeContext): ComputedStatus {
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

interface SelfConditions {
  readonly prereqs: string | undefined;
  readonly prereqsAck: boolean;
  readonly orphaned: boolean;
  readonly disabledByUser: boolean;
}

function computeWithDeps(
  self: SelfConditions,
  deps: { skills: readonly string[]; mcps: readonly string[] },
  ctx: CascadeContext,
): ComputedStatus {
  // Self causes — these don't depend on the dep graph.
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

  // Cascade: walk direct deps, recurse for skills, leaf-check for mcps.
  const missing: MissingDep[] = [];
  const blocked: BlockedDep[] = [];

  for (const skillOrigin of deps.skills) {
    const child = ctx.skillByOrigin.get(skillOrigin);
    if (child === undefined) {
      missing.push({ kind: "skill", name: skillOrigin });
      continue;
    }
    const childStatus = computeSkillStatus(child, ctx);
    if (childStatus.status === "blocked") {
      blocked.push({ kind: "skill", fqn: child.fqn });
    }
  }
  for (const mcpOrigin of deps.mcps) {
    const child = ctx.mcpByOrigin.get(mcpOrigin);
    if (child === undefined) {
      missing.push({ kind: "mcp", name: mcpOrigin });
    }
    // No mcp cascade-block: an mcp that THIS entry depends on is by
    // definition not orphan (the dep itself is a reverse-dep). The
    // old stored-flag model could yield a stale "orphan" mcp despite
    // a live ref; the derived model can't, so the cascade case is
    // unreachable. Mcps are leaves: missing-dep above is the only
    // way they contribute to the parent's blockedReason.
  }
  if (missing.length > 0) reason.missingDeps = missing;
  if (blocked.length > 0) reason.blockedDeps = blocked;

  if (Object.keys(reason).length === 0) return { status: "ready" };
  return { status: "blocked", reason: reason as BlockedReason };
}

function buildSkillEntry(s: Skill, ctx: CascadeContext): SkillEntry {
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

function buildAgentEntry(a: Agent, ctx: CascadeContext): AgentEntry {
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

/**
 * Project a persisted entity into the lightweight
 * {@link CatalogInstalledEntry} shape used in install responses.
 *
 * For mcps: just kind+fqn (mcps have no prereqs).
 * For skills/agents: include `prereqs` iff the entry has non-empty
 * prereqs text, plus the post-install `prereqsAck` flag so callers
 * can prompt the user when an ack is pending.
 */
function toInstalledEntry(
  kind: "mcp" | "skill" | "agent",
  fqn: string,
  entity: Skill | Agent | Mcp,
): CatalogInstalledEntry {
  if (kind === "mcp") return { kind, fqn };
  // Both Skill and Agent expose `prereqs` and `prereqsAck`.
  const e = entity as Skill | Agent;
  const prereqs = e.prereqs;
  const out: CatalogInstalledEntry = {
    kind,
    fqn,
    prereqsAck: e.prereqsAck,
  };
  if (prereqs !== undefined && prereqs.trim().length > 0) {
    return { ...out, prereqs };
  }
  return out;
}

function conflictToError(c: CatalogConflict): Error {
  if (c.reason.kind === "fetch-failed" || c.reason.kind === "parse-failed") {
    return c.reason.cause instanceof Error
      ? c.reason.cause
      : new Error(`catalog ${c.kind} resolve failed: ${c.reason.kind}`);
  }
  return new Error(`catalog ${c.kind} resolve conflict: ${JSON.stringify(c.reason)}`);
}

/**
 * Project a thrown error into the wire-safe `{ name, message }` shape
 * we put on `CatalogInstallResult.failed[].error`. `Error` instances'
 * `name` and `message` are non-enumerable, so a naive `JSON.stringify`
 * yields `{}` and clients lose all signal — this normalisation keeps
 * the failure information present across the HTTP boundary.
 */
function errorToWire(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { name: "Error", message: err };
  return { name: "Error", message: String(err) };
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

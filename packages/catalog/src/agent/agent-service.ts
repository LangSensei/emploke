import {
  type AnchoredFetcher,
  type AnchoredResolveConflict,
  type AnchoredResolvedNode,
  type AnchoredResolveEvent,
  type AnchoredResolveOptions,
  type AnchoredResolvePlan,
  applyFrontmatterPatch,
  assertOriginMutable,
  FORBIDDEN_METADATA_PATCH_KEYS,
  readFetcherTree,
  resolveAnchoredOrigin,
  resolveSiblingOrigins,
  sameOrigin,
} from "../_shared/service-helpers.js";
import type { EntryFile } from "../fetcher/index.js";
import type { McpRepository } from "../mcp/mcp-repository.js";
import type { SkillRepository } from "../skill/skill-repository.js";
import { AgentEntity } from "./agent-entity.js";
import { AGENT_DEP_SPECS, type AgentDepKind } from "./agent-frontmatter.js";
import type { AgentFile, AgentRepository } from "./agent-repository.js";
import {
  AgentFrontmatterError,
  AgentNotFoundError,
  AgentOriginConflictError,
  AgentPlanStaleError,
} from "./errors.js";

export interface AgentFetcher {
  fetchAnchor(origin: string): Promise<string>;
  fetchTree(origin: string): AsyncIterable<EntryFile>;
}

// Type aliases preserved as part of the public API surface — they are
// re-exported from `agent/index.ts` and consumed by `catalog/index.ts`
// (which in turn re-exports them under their kind-prefixed names).
export type AgentResolveOptions = AnchoredResolveOptions;
export type AgentResolveEvent = AnchoredResolveEvent;
export type AgentResolvedNode = AnchoredResolvedNode<AgentDepKind>;
export type AgentResolveConflict = AnchoredResolveConflict;
export type AgentResolvePlan = AnchoredResolvePlan<AgentDepKind>;

/**
 * Application-layer service for agent operations. Composition over
 * inheritance: the cross-kind resolve/install workflow lives in
 * `_shared/service-helpers.ts`; this class wires the agent-specific
 * fetcher, entity factory, error classes, and sibling lookup.
 *
 * Sibling repos are optional in legacy callers; when omitted, dep
 * refs that cannot be resolved are silently dropped (mirrors the v1
 * catalog's tolerant behaviour).
 *
 * The agent-only `disableByUser` / `enableByUser` methods live here
 * (skills cannot be user-disabled).
 */
export class AgentService {
  constructor(
    private readonly repo: AgentRepository,
    private readonly fetcher: AgentFetcher,
    private readonly siblings: {
      readonly skills?: SkillRepository;
      readonly mcps?: McpRepository;
    } = {},
  ) {}

  resolve(origin: string, opts: AgentResolveOptions = {}): Promise<AgentResolvePlan> {
    return resolveAnchoredOrigin<AgentEntity, AgentDepKind>({
      origin,
      fetcher: this.fetcher as AnchoredFetcher,
      repo: this.repo,
      createEntity: (raw, o, label) => AgentEntity.create(raw, o, label),
      options: opts,
      depsOf: (e) => e.depsRefs,
      identityOf: (e) => ({ fqn: e.fqn, origin: e.origin, version: e.version }),
      originOf: (e) => e.origin,
      depSpecs: AGENT_DEP_SPECS,
    });
  }

  async install(planOrOrigin: AgentResolvedNode | string): Promise<AgentEntity> {
    let node: AgentResolvedNode;
    if (typeof planOrOrigin === "string") {
      const plan = await this.resolve(planOrOrigin);
      if (plan.conflict !== null) throw conflictToError(plan.conflict);
      if (plan.node === null) {
        throw new Error("unreachable: resolve returned neither node nor conflict");
      }
      node = plan.node;
    } else {
      node = planOrOrigin;
    }

    const { files, anchorContent } = await readFetcherTree(
      this.fetcher as AnchoredFetcher,
      node.origin,
      "AGENTS.md",
    );
    if (anchorContent === null) {
      throw new AgentFrontmatterError(
        `install:${node.origin}`,
        "fetcher yielded no AGENTS.md (agent must contain a top-level AGENTS.md)",
      );
    }

    let entity = AgentEntity.create(anchorContent, node.origin, `install:${node.origin}`);

    if (entity.version !== node.version) {
      throw new AgentPlanStaleError(node.fqn, node.origin, node.version, entity.version);
    }

    const existing = await this.repo.findByFqn(entity.fqn);
    if (existing !== null && !sameOrigin(existing.origin, entity.origin)) {
      throw new AgentOriginConflictError(entity.fqn, existing.origin, entity.origin);
    }

    if (existing !== null) {
      const prereqsAck =
        (existing.prereqs ?? "") === (entity.prereqs ?? "")
          ? existing.prereqsAck
          : entity.prereqsAck;
      entity = entity.withState({ prereqsAck, disabledByUser: existing.disabledByUser });
    }

    const resolvedDeps = await this.resolveDepOrigins(entity.depsRefs);
    await this.repo.add(entity, files, resolvedDeps);
    return (await this.repo.findByFqn(entity.fqn)) ?? entity;
  }

  async get(fqn: string): Promise<AgentEntity | null> {
    return this.repo.findByFqn(fqn);
  }

  async list(): Promise<AgentEntity[]> {
    return this.repo.findAll();
  }

  async has(fqn: string): Promise<boolean> {
    return (await this.repo.findByFqn(fqn)) !== null;
  }

  async getByOrigin(origin: string): Promise<AgentEntity | null> {
    return this.repo.findByOrigin(origin);
  }

  streamFiles(fqn: string): AsyncIterable<AgentFile> {
    return this.repo.streamFiles(fqn);
  }

  async getAnchor(fqn: string): Promise<string> {
    return this.repo.getAnchor(fqn);
  }

  async updateAnchor(fqn: string, newAgentMd: string): Promise<AgentEntity> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new AgentNotFoundError(fqn);
    assertOriginMutable(fqn, existing.origin);
    const updated = existing.withAnchor(newAgentMd, `update:${fqn}`);
    const files = new Map<string, Buffer>();
    for await (const f of this.repo.streamFiles(fqn)) {
      files.set(f.relPath, f.content);
    }
    files.set("AGENTS.md", Buffer.from(newAgentMd, "utf8"));
    const resolvedDeps = await this.resolveDepOrigins(updated.depsRefs);
    await this.repo.add(updated, files, resolvedDeps);
    return (await this.repo.findByFqn(fqn)) ?? updated;
  }

  async updateMetadata(fqn: string, patch: Record<string, unknown>): Promise<AgentEntity> {
    for (const k of Object.keys(patch)) {
      if (FORBIDDEN_METADATA_PATCH_KEYS.has(k)) {
        throw new AgentFrontmatterError(
          `update:${fqn}`,
          `cannot patch field "${k}" — fqn (scope/name) is immutable. ` +
            "To rename, install under a new origin and delete the old entry.",
        );
      }
    }
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new AgentNotFoundError(fqn);
    assertOriginMutable(fqn, existing.origin);
    const currentAnchor = await this.repo.getAnchor(fqn);
    const newAnchor = applyFrontmatterPatch(currentAnchor, patch);
    return this.updateAnchor(fqn, newAnchor);
  }

  async delete(fqn: string): Promise<void> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new AgentNotFoundError(fqn);
    await this.repo.delete(fqn);
  }

  async acknowledgePrereqs(fqn: string): Promise<AgentEntity> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new AgentNotFoundError(fqn);
    if (!existing.prereqsAck) {
      await this.repo.setFlags(fqn, { prereqsAck: true });
    }
    const updated = await this.repo.findByFqn(fqn);
    if (updated === null) throw new AgentNotFoundError(fqn);
    return updated;
  }

  async disableByUser(fqn: string): Promise<AgentEntity> {
    return this.setUserDisabled(fqn, true);
  }

  async enableByUser(fqn: string): Promise<AgentEntity> {
    return this.setUserDisabled(fqn, false);
  }

  private async setUserDisabled(fqn: string, value: boolean): Promise<AgentEntity> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new AgentNotFoundError(fqn);
    if (existing.disabledByUser !== value) {
      await this.repo.setFlags(fqn, { disabledByUser: value });
    }
    const updated = await this.repo.findByFqn(fqn);
    if (updated === null) throw new AgentNotFoundError(fqn);
    return updated;
  }

  async setFlags(
    fqn: string,
    flags: { prereqsAck?: boolean; disabledByUser?: boolean },
  ): Promise<void> {
    await this.repo.setFlags(fqn, flags);
  }

  close(): void {
    this.repo.close?.();
  }

  /**
   * Resolve frontmatter dep origins to local sibling fqns. Origins
   * that don't resolve to an installed sibling are silently skipped —
   * matches v1 tolerant behaviour, lets the resolve pipeline surface
   * `MissingDep` separately if the consumer cares.
   */
  private async resolveDepOrigins(refs: {
    readonly skills: readonly string[];
    readonly mcps: readonly string[];
  }): Promise<{ skills: string[]; mcps: string[] }> {
    const lookups: Partial<
      Record<AgentDepKind, (origin: string) => Promise<{ fqn: string } | null>>
    > = {};
    if (this.siblings.skills !== undefined) {
      const repo = this.siblings.skills;
      lookups.skills = (origin) => repo.findByOrigin(origin);
    }
    if (this.siblings.mcps !== undefined) {
      const repo = this.siblings.mcps;
      lookups.mcps = (origin) => repo.findByOrigin(origin);
    }
    const out = await resolveSiblingOrigins<AgentDepKind>(refs, lookups);
    return { skills: out.skills, mcps: out.mcps };
  }
}

function conflictToError(c: AgentResolveConflict): Error {
  if (c.reason.kind === "fetch-failed" || c.reason.kind === "parse-failed") {
    return c.reason.cause instanceof Error
      ? c.reason.cause
      : new Error(`agent resolve failed: ${c.reason.kind}`);
  }
  if (c.reason.kind === "origin-conflict" && c.fqn !== null) {
    return new AgentOriginConflictError(c.fqn, c.reason.existingOrigin, c.origin);
  }
  return new Error(`agent resolve conflict: ${JSON.stringify(c.reason)}`);
}

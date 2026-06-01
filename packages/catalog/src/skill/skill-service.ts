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
  sameOrigin,
} from "../_shared/service-helpers.js";
import type { EntryFile } from "../fetcher/index.js";
import type { McpRepository } from "../mcp/mcp-repository.js";
import {
  PlanStaleError,
  SkillFrontmatterError,
  SkillNotFoundError,
  SkillOriginConflictError,
} from "./errors.js";
import { SkillEntity } from "./skill-entity.js";
import { SKILL_DEP_SPECS, type SkillDepKind } from "./skill-frontmatter.js";
import type { SkillFile, SkillRepository } from "./skill-repository.js";

export interface SkillFetcher {
  fetchAnchor(origin: string): Promise<string>;
  fetchTree(origin: string): AsyncIterable<EntryFile>;
}

// Type aliases preserved as part of the public API surface — they are
// re-exported from `skill/index.ts` and consumed by `catalog/index.ts`.
export type SkillResolveOptions = AnchoredResolveOptions;
export type SkillResolveEvent = AnchoredResolveEvent;
export type SkillResolvedNode = AnchoredResolvedNode<SkillDepKind>;
export type SkillResolveConflict = AnchoredResolveConflict;
export type SkillResolvePlan = AnchoredResolvePlan<SkillDepKind>;

/**
 * Application-layer service for skill operations. Composition over
 * inheritance: the cross-kind resolve/install workflow lives in
 * `_shared/service-helpers.ts`; this class wires the skill-specific
 * fetcher, entity factory, error classes, and sibling lookup.
 *
 * Skill dep resolution looks up sibling skills in THIS repo (skills
 * may depend on other skills); MCP deps go through the injected
 * `siblings.mcps` repo. Skills cannot be user-disabled — no
 * `disable/enable` methods live here.
 */
export class SkillService {
  constructor(
    private readonly repo: SkillRepository,
    private readonly fetcher: SkillFetcher,
    private readonly siblings: {
      readonly mcps?: McpRepository;
    } = {},
  ) {}

  resolve(origin: string, opts: SkillResolveOptions = {}): Promise<SkillResolvePlan> {
    return resolveAnchoredOrigin<SkillEntity, SkillDepKind>({
      origin,
      fetcher: this.fetcher as AnchoredFetcher,
      repo: this.repo,
      createEntity: (raw, o, label) => SkillEntity.create(raw, o, label),
      options: opts,
      depsOf: (e) => e.depsRefs,
      identityOf: (e) => ({ fqn: e.fqn, origin: e.origin, version: e.version }),
      originOf: (e) => e.origin,
      depSpecs: SKILL_DEP_SPECS,
    });
  }

  async install(planOrOrigin: SkillResolvedNode | string): Promise<SkillEntity> {
    let node: SkillResolvedNode;
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
      "SKILL.md",
    );
    if (anchorContent === null) {
      throw new SkillFrontmatterError(
        `install:${node.origin}`,
        "fetcher yielded no SKILL.md (skill must contain a top-level SKILL.md)",
      );
    }

    let entity = SkillEntity.create(anchorContent, node.origin, `install:${node.origin}`);

    if (entity.version !== node.version) {
      throw new PlanStaleError(node.fqn, node.origin, node.version, entity.version);
    }

    const existing = await this.repo.findByFqn(entity.fqn);
    if (existing !== null && !sameOrigin(existing.origin, entity.origin)) {
      throw new SkillOriginConflictError(entity.fqn, existing.origin, entity.origin);
    }

    if (existing !== null) {
      const prereqsAck =
        (existing.prereqs ?? "") === (entity.prereqs ?? "")
          ? existing.prereqsAck
          : entity.prereqsAck;
      entity = entity.withState({ prereqsAck });
    }

    const resolvedDeps = await this.resolveDepOrigins(entity.depsRefs);
    await this.repo.add(entity, files, resolvedDeps);
    return (await this.repo.findByFqn(entity.fqn)) ?? entity;
  }

  async get(fqn: string): Promise<SkillEntity | null> {
    return this.repo.findByFqn(fqn);
  }

  async list(): Promise<SkillEntity[]> {
    return this.repo.findAll();
  }

  async has(fqn: string): Promise<boolean> {
    return (await this.repo.findByFqn(fqn)) !== null;
  }

  async getByOrigin(origin: string): Promise<SkillEntity | null> {
    return this.repo.findByOrigin(origin);
  }

  streamFiles(fqn: string): AsyncIterable<SkillFile> {
    return this.repo.streamFiles(fqn);
  }

  async getAnchor(fqn: string): Promise<string> {
    return this.repo.getAnchor(fqn);
  }

  async updateAnchor(fqn: string, newSkillMd: string): Promise<SkillEntity> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new SkillNotFoundError(fqn);
    assertOriginMutable(fqn, existing.origin);
    const updated = existing.withAnchor(newSkillMd, `update:${fqn}`);
    const files = new Map<string, Buffer>();
    for await (const f of this.repo.streamFiles(fqn)) {
      files.set(f.relPath, f.content);
    }
    files.set("SKILL.md", Buffer.from(newSkillMd, "utf8"));
    const resolvedDeps = await this.resolveDepOrigins(updated.depsRefs);
    await this.repo.add(updated, files, resolvedDeps);
    return (await this.repo.findByFqn(fqn)) ?? updated;
  }

  async updateMetadata(fqn: string, patch: Record<string, unknown>): Promise<SkillEntity> {
    for (const k of Object.keys(patch)) {
      if (FORBIDDEN_METADATA_PATCH_KEYS.has(k)) {
        throw new SkillFrontmatterError(
          `update:${fqn}`,
          `cannot patch field "${k}" — fqn (scope/name) is immutable. ` +
            "To rename, install under a new origin and delete the old entry.",
        );
      }
    }
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new SkillNotFoundError(fqn);
    assertOriginMutable(fqn, existing.origin);
    const currentAnchor = await this.repo.getAnchor(fqn);
    const newAnchor = applyFrontmatterPatch(currentAnchor, patch);
    return this.updateAnchor(fqn, newAnchor);
  }

  async delete(fqn: string): Promise<void> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new SkillNotFoundError(fqn);
    await this.repo.delete(fqn);
  }

  async acknowledgePrereqs(fqn: string): Promise<SkillEntity> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new SkillNotFoundError(fqn);
    if (!existing.prereqsAck) {
      await this.repo.setFlags(fqn, { prereqsAck: true });
    }
    const updated = await this.repo.findByFqn(fqn);
    if (updated === null) throw new SkillNotFoundError(fqn);
    return updated;
  }

  async setFlags(fqn: string, flags: { prereqsAck?: boolean }): Promise<void> {
    await this.repo.setFlags(fqn, flags);
  }

  close(): void {
    this.repo.close?.();
  }

  /**
   * Resolve frontmatter dep origins to local sibling fqns. Skill deps
   * are looked up in THIS repo (skills can depend on other skills);
   * MCP deps go through `siblings.mcps`. Origins that don't resolve
   * are silently skipped — matches v1 tolerant behaviour.
   *
   * Not factored through `resolveSiblingOrigins` because the skill
   * bucket points at THIS service's repo, not an injected sibling;
   * inlining the loop is one line per kind and keeps the lookup
   * source obvious.
   */
  private async resolveDepOrigins(refs: {
    readonly skills: readonly string[];
    readonly mcps: readonly string[];
  }): Promise<{ skills: string[]; mcps: string[] }> {
    const skillFqns: string[] = [];
    const mcpFqns: string[] = [];
    for (const origin of refs.skills) {
      const sib = await this.repo.findByOrigin(origin);
      if (sib !== null) skillFqns.push(sib.fqn);
    }
    if (this.siblings.mcps !== undefined) {
      for (const origin of refs.mcps) {
        const sib = await this.siblings.mcps.findByOrigin(origin);
        if (sib !== null) mcpFqns.push(sib.fqn);
      }
    }
    return { skills: skillFqns, mcps: mcpFqns };
  }
}

function conflictToError(c: SkillResolveConflict): Error {
  if (c.reason.kind === "fetch-failed" || c.reason.kind === "parse-failed") {
    return c.reason.cause instanceof Error
      ? c.reason.cause
      : new Error(`skill resolve failed: ${c.reason.kind}`);
  }
  if (c.reason.kind === "origin-conflict" && c.fqn !== null) {
    return new SkillOriginConflictError(c.fqn, c.reason.existingOrigin, c.origin);
  }
  return new Error(`skill resolve conflict: ${JSON.stringify(c.reason)}`);
}

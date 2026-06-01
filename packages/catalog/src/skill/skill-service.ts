import { normaliseOriginDeps, type OriginDeps } from "../_shared/dep-keys.js";
import {
  applyFrontmatterPatch,
  assertOriginMutable,
  FORBIDDEN_METADATA_PATCH_KEYS,
  readFetcherTree,
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

// Per-kind resolve types. Mirrored from the agent side by intent —
// see the maintainer principle in skill-entity.ts's header JSDoc: there
// is no shared `Anchored*` abstraction because agent and skill are
// independent kinds. Duplication beats domain coupling.

export type SkillResolveEvent =
  | { type: "fetching"; origin: string }
  | { type: "fetched"; origin: string; fqn: string }
  | { type: "alreadyInstalled"; fqn: string }
  | { type: "failed"; origin: string; error: unknown };

export interface SkillResolveOptions {
  signal?: AbortSignal;
  onProgress?: (event: SkillResolveEvent) => void;
}

export interface SkillResolvedNode {
  readonly fqn: string;
  readonly origin: string;
  readonly anchorContent: string;
  readonly version: string;
  readonly depsRefs: OriginDeps<SkillDepKind>;
}

export type SkillResolveConflict = {
  readonly origin: string;
  readonly fqn: string | null;
  readonly reason:
    | { kind: "fetch-failed"; cause: unknown }
    | { kind: "parse-failed"; cause: unknown }
    | { kind: "origin-conflict"; existingOrigin: string };
};

export interface SkillResolvePlan {
  readonly node: SkillResolvedNode | null;
  readonly conflict: SkillResolveConflict | null;
}

/**
 * Pure resolve workflow: fetch the anchor bytes, parse them into a
 * `SkillEntity`, check for origin conflicts against the local repo,
 * build the resolved-node payload. Returns `{node, conflict}` — the
 * caller maps the conflict to `SkillOriginConflictError`.
 *
 * Mirrors `resolveAgentOrigin` in `agent/agent-service.ts` by intent;
 * the two copies are independent and must NOT be re-factored into a
 * shared helper (see the skill-entity.ts header JSDoc for the
 * principle).
 */
async function resolveSkillOrigin(args: {
  readonly origin: string;
  readonly fetcher: SkillFetcher;
  readonly repo: SkillRepository;
  readonly options?: SkillResolveOptions;
}): Promise<SkillResolvePlan> {
  const { origin, fetcher, repo } = args;
  const onProgress = args.options?.onProgress ?? (() => {});

  onProgress({ type: "fetching", origin });
  let anchorBytes: string;
  try {
    anchorBytes = await fetcher.fetchAnchor(origin);
  } catch (cause) {
    onProgress({ type: "failed", origin, error: cause });
    return {
      node: null,
      conflict: { origin, fqn: null, reason: { kind: "fetch-failed", cause } },
    };
  }

  let entity: SkillEntity;
  try {
    entity = SkillEntity.create(anchorBytes, origin, `resolve:${origin}`);
  } catch (cause) {
    onProgress({ type: "failed", origin, error: cause });
    return {
      node: null,
      conflict: { origin, fqn: null, reason: { kind: "parse-failed", cause } },
    };
  }

  const existing = await repo.findByFqn(entity.fqn);
  if (existing !== null && !sameOrigin(existing.origin, entity.origin)) {
    return {
      node: null,
      conflict: {
        origin,
        fqn: entity.fqn,
        reason: { kind: "origin-conflict", existingOrigin: existing.origin },
      },
    };
  }

  const depsRefs = normaliseOriginDeps(SKILL_DEP_SPECS, entity.depsRefs);
  const node: SkillResolvedNode = {
    fqn: entity.fqn,
    origin: entity.origin,
    anchorContent: anchorBytes,
    version: entity.version,
    depsRefs,
  };
  onProgress({ type: "fetched", origin, fqn: node.fqn });
  return { node, conflict: null };
}

/**
 * Application-layer service for skill operations. Skill owns its
 * resolve workflow inline (see `resolveSkillOrigin` above) plus its
 * resolve-result types declared in this file. Agent mirrors the same
 * shape in `agent/agent-service.ts` by intent — agent and skill are
 * independent kinds with no shared domain methods.
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
    return resolveSkillOrigin({
      origin,
      fetcher: this.fetcher,
      repo: this.repo,
      options: opts,
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

    const { files, anchorContent } = await readFetcherTree(this.fetcher, node.origin, "SKILL.md");
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
   * Inlined per kind (skill owns this lookup loop) — the skill bucket
   * points at THIS service's repo, not an injected sibling, so the
   * loop reads cleanly without indirection.
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

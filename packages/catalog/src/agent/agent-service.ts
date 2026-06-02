import matter from "gray-matter";
import { normaliseOriginDeps, type OriginDeps } from "../_shared/dep-keys.js";
import { type EntryFile, sameOrigin } from "../fetcher/index.js";
import type { McpRepository } from "../mcp/mcp-repository.js";
import { ImmutableOriginError, isOriginMutable } from "../origin-mutability.js";
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

/** FQN-immutable patch keys — never accepted by `updateMetadata`. */
const FORBIDDEN_METADATA_PATCH_KEYS: ReadonlySet<string> = new Set(["name", "scope", "fqn"]);

export interface AgentFetcher {
  fetchAnchor(origin: string): Promise<string>;
  fetchTree(origin: string): AsyncIterable<EntryFile>;
}

// Per-kind resolve types. Mirrored from the skill side by intent —
// agent and skill are independent kinds with no shared `Anchored*`
// abstraction. Duplication beats domain coupling.

export type AgentResolveEvent =
  | { type: "fetching"; origin: string }
  | { type: "fetched"; origin: string; fqn: string }
  | { type: "alreadyInstalled"; fqn: string }
  | { type: "failed"; origin: string; error: unknown };

export interface AgentResolveOptions {
  signal?: AbortSignal;
  onProgress?: (event: AgentResolveEvent) => void;
}

export interface AgentResolvedNode {
  readonly fqn: string;
  readonly origin: string;
  readonly anchorContent: string;
  readonly version: string;
  readonly depsRefs: OriginDeps<AgentDepKind>;
}

export type AgentResolveConflict = {
  readonly origin: string;
  readonly fqn: string | null;
  readonly reason:
    | { kind: "fetch-failed"; cause: unknown }
    | { kind: "parse-failed"; cause: unknown }
    | { kind: "origin-conflict"; existingOrigin: string };
};

export interface AgentResolvePlan {
  readonly node: AgentResolvedNode | null;
  readonly conflict: AgentResolveConflict | null;
}

/**
 * Pure resolve workflow: fetch the anchor bytes, parse them into an
 * `AgentEntity`, check for origin conflicts against the local repo,
 * build the resolved-node payload. Returns `{node, conflict}` — the
 * caller maps the conflict to `AgentOriginConflictError`.
 *
 * Mirrors `resolveSkillOrigin` in `skill/skill-service.ts` by intent;
 * the two copies are independent and must NOT be re-factored into a
 * shared helper.
 */
async function resolveAgentOrigin(args: {
  readonly origin: string;
  readonly fetcher: AgentFetcher;
  readonly repo: AgentRepository;
  readonly options?: AgentResolveOptions;
}): Promise<AgentResolvePlan> {
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

  let entity: AgentEntity;
  try {
    entity = AgentEntity.create(anchorBytes, origin, `resolve:${origin}`);
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

  const depsRefs = normaliseOriginDeps(AGENT_DEP_SPECS, entity.depsRefs);
  const node: AgentResolvedNode = {
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
 * Application-layer service for agent operations. Agent owns its
 * resolve workflow inline (see `resolveAgentOrigin` above) plus its
 * resolve-result types declared in this file. Skill mirrors the same
 * shape in `skill/skill-service.ts` by intent — agent and skill are
 * independent kinds with no shared domain methods.
 *
 * Sibling repos are optional; when omitted, dep refs that cannot be
 * resolved are silently skipped (matches the catalog's tolerant
 * behaviour).
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
    return resolveAgentOrigin({
      origin,
      fetcher: this.fetcher,
      repo: this.repo,
      options: opts,
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

    const files = new Map<string, Buffer>();
    let anchorContent: string | null = null;
    for await (const file of this.fetcher.fetchTree(node.origin)) {
      files.set(file.relPath, file.content);
      if (file.relPath === "AGENTS.md") {
        anchorContent = file.content.toString("utf8");
      }
    }
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
    if (!isOriginMutable(existing.origin)) throw new ImmutableOriginError(fqn, existing.origin);
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
    if (!isOriginMutable(existing.origin)) throw new ImmutableOriginError(fqn, existing.origin);
    const currentAnchor = await this.repo.getAnchor(fqn);
    const file = matter(currentAnchor);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) delete file.data[k];
      else file.data[k] = v;
    }
    const newAnchor = matter.stringify(file.content, file.data);
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
   * matches the catalog's tolerant behaviour and lets the resolve
   * pipeline surface `MissingDep` separately if the consumer cares.
   *
   * Inlined per kind (agent owns this lookup loop) — no shared
   * sibling-lookup helper exists, by design.
   */
  private async resolveDepOrigins(refs: {
    readonly skills: readonly string[];
    readonly mcps: readonly string[];
  }): Promise<{ skills: string[]; mcps: string[] }> {
    const skills: string[] = [];
    if (this.siblings.skills !== undefined) {
      const repo = this.siblings.skills;
      for (const origin of refs.skills) {
        const sib = await repo.findByOrigin(origin);
        if (sib !== null) skills.push(sib.fqn);
      }
    }
    const mcps: string[] = [];
    if (this.siblings.mcps !== undefined) {
      const repo = this.siblings.mcps;
      for (const origin of refs.mcps) {
        const sib = await repo.findByOrigin(origin);
        if (sib !== null) mcps.push(sib.fqn);
      }
    }
    return { skills, mcps };
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

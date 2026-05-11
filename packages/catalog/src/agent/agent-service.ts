import type { EntryFile } from "@emploke/catalog-fetcher";
import { normalizeOrigin, parseOrigin } from "@emploke/catalog-fetcher";
import { applyFrontmatterPatch } from "../compat/frontmatter-patch.js";
import { ImmutableOriginError, isOriginMutable } from "../origin-mutability.js";
import { Agent } from "./agent-entity.js";
import type { AgentFile, AgentRepository } from "./agent-repository.js";
import {
  AgentFrontmatterError,
  AgentNotFoundError,
  AgentOriginConflictError,
  AgentPlanStaleError,
} from "./errors.js";

/**
 * Application-layer service for agent operations. Mirror of
 * {@link SkillService}; agents are root entities (never dep-referenced
 * by other entities), so this service still walks one level into
 * deps but doesn't recurse — facade does cross-entity coordination.
 */

export interface AgentFetcher {
  fetchAnchor(origin: string): Promise<string>;
  fetchTree(origin: string): AsyncIterable<EntryFile>;
}

export interface AgentResolveOptions {
  signal?: AbortSignal;
  onProgress?: (event: AgentResolveEvent) => void;
}

export type AgentResolveEvent =
  | { type: "fetching"; origin: string }
  | { type: "fetched"; origin: string; fqn: string }
  | { type: "alreadyInstalled"; fqn: string }
  | { type: "failed"; origin: string; error: unknown };

export interface AgentResolvePlan {
  readonly node: AgentResolvedNode | null;
  readonly conflict: AgentResolveConflict | null;
}

export interface AgentResolvedNode {
  readonly fqn: string;
  readonly origin: string;
  readonly anchorContent: string;
  readonly frontmatterSha256: string;
  readonly depsRefs: {
    readonly skills: readonly string[];
    readonly mcps: readonly string[];
  };
}

export type AgentResolveConflict = {
  readonly origin: string;
  readonly fqn: string | null;
  readonly reason:
    | { kind: "fetch-failed"; cause: unknown }
    | { kind: "parse-failed"; cause: unknown }
    | { kind: "origin-conflict"; existingOrigin: string };
};

export class AgentService {
  constructor(
    private readonly repo: AgentRepository,
    private readonly fetcher: AgentFetcher,
  ) {}

  async resolve(origin: string, opts: AgentResolveOptions = {}): Promise<AgentResolvePlan> {
    const onProgress = opts.onProgress ?? (() => {});

    onProgress({ type: "fetching", origin });
    let anchorBytes: string;
    try {
      anchorBytes = await this.fetcher.fetchAnchor(origin);
    } catch (cause) {
      onProgress({ type: "failed", origin, error: cause });
      return {
        node: null,
        conflict: { origin, fqn: null, reason: { kind: "fetch-failed", cause } },
      };
    }

    let entity: Agent;
    try {
      entity = Agent.create(anchorBytes, origin, `resolve:${origin}`);
    } catch (cause) {
      onProgress({ type: "failed", origin, error: cause });
      return {
        node: null,
        conflict: { origin, fqn: null, reason: { kind: "parse-failed", cause } },
      };
    }

    const byFqn = await this.repo.findByFqn(entity.fqn);
    if (byFqn !== null && !sameOrigin(byFqn.origin, entity.origin)) {
      return {
        node: null,
        conflict: {
          origin,
          fqn: entity.fqn,
          reason: { kind: "origin-conflict", existingOrigin: byFqn.origin },
        },
      };
    }

    const node: AgentResolvedNode = {
      fqn: entity.fqn,
      origin: entity.origin,
      anchorContent: entity.anchorContent,
      frontmatterSha256: entity.frontmatterSha256,
      depsRefs: {
        skills: [...entity.dependencies.skills],
        mcps: [...entity.dependencies.mcps],
      },
    };
    onProgress({ type: "fetched", origin, fqn: node.fqn });
    return { node, conflict: null };
  }

  async install(planOrOrigin: AgentResolvedNode | string): Promise<Agent> {
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

    let entity = Agent.create(anchorContent, node.origin, `install:${node.origin}`);

    if (entity.frontmatterSha256 !== node.frontmatterSha256) {
      throw new AgentPlanStaleError(
        node.fqn,
        node.origin,
        node.frontmatterSha256,
        entity.frontmatterSha256,
      );
    }

    const existing = await this.repo.findByFqn(entity.fqn);
    if (existing !== null && !sameOrigin(existing.origin, entity.origin)) {
      throw new AgentOriginConflictError(entity.fqn, existing.origin, entity.origin);
    }

    // Carry-over rules — see SkillService.install for prereqsAck;
    // disabledByUser is purely user-controlled and ALWAYS preserved
    // across syncs (system never flips it).
    if (existing !== null) {
      const prereqsAck =
        (existing.prereqs ?? "") === (entity.prereqs ?? "")
          ? existing.prereqsAck
          : entity.prereqsAck;
      entity = entity.withState({ prereqsAck, disabledByUser: existing.disabledByUser });
    }

    await this.repo.add(entity, files);
    return entity;
  }

  async get(fqn: string): Promise<Agent | null> {
    return this.repo.findByFqn(fqn);
  }

  async list(): Promise<Agent[]> {
    return this.repo.findAll();
  }

  async has(fqn: string): Promise<boolean> {
    return (await this.repo.findByFqn(fqn)) !== null;
  }

  async getByOrigin(origin: string): Promise<Agent | null> {
    return this.repo.findByOrigin(origin);
  }

  streamFiles(fqn: string): AsyncIterable<AgentFile> {
    return this.repo.streamFiles(fqn);
  }

  async updateAnchor(fqn: string, newAgentMd: string): Promise<Agent> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new AgentNotFoundError(fqn);
    if (!isOriginMutable(existing.origin)) {
      throw new ImmutableOriginError(fqn, existing.origin);
    }
    const updated = existing.withAnchor(newAgentMd, `update:${fqn}`);
    const files = new Map<string, Buffer>();
    for await (const f of this.repo.streamFiles(fqn)) {
      files.set(f.relPath, f.content);
    }
    files.set("AGENTS.md", Buffer.from(updated.anchorContent, "utf8"));
    await this.repo.add(updated, files);
    return updated;
  }

  /** See {@link SkillService.updateMetadata}. Same semantics for AGENTS.md. */
  async updateMetadata(fqn: string, patch: Record<string, unknown>): Promise<Agent> {
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
    if (!isOriginMutable(existing.origin)) {
      throw new ImmutableOriginError(fqn, existing.origin);
    }
    const newAnchor = applyFrontmatterPatch(existing.anchorContent, patch);
    return this.updateAnchor(fqn, newAnchor);
  }

  async delete(fqn: string): Promise<void> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new AgentNotFoundError(fqn);
    await this.repo.delete(fqn);
  }

  /** See {@link SkillService.acknowledgePrereqs}. */
  async acknowledgePrereqs(fqn: string): Promise<Agent> {
    const existing = await this.repo.findByFqn(fqn);
    if (existing === null) throw new AgentNotFoundError(fqn);
    if (!existing.prereqsAck) {
      await this.repo.setFlags(fqn, { prereqsAck: true });
    }
    const updated = await this.repo.findByFqn(fqn);
    if (updated === null) throw new AgentNotFoundError(fqn);
    return updated;
  }

  /** Flip `disabled_by_user` to `true`. Idempotent. */
  async disableByUser(fqn: string): Promise<Agent> {
    return this.setUserDisabled(fqn, true);
  }

  /** Flip `disabled_by_user` to `false`. Idempotent. */
  async enableByUser(fqn: string): Promise<Agent> {
    return this.setUserDisabled(fqn, false);
  }

  private async setUserDisabled(fqn: string, value: boolean): Promise<Agent> {
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

  /** Release the underlying repository's resources. Idempotent. */
  close(): void {
    this.repo.close?.();
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return normalizeOrigin(parseOrigin(a)) === normalizeOrigin(parseOrigin(b));
  } catch {
    return a === b;
  }
}

const FORBIDDEN_METADATA_PATCH_KEYS = new Set<string>(["name", "scope", "fqn"]);

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

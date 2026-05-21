import { normalizeOrigin, parseOrigin } from "../fetcher/index.js";
import { ImmutableOriginError, isOriginMutable } from "../origin-mutability.js";
import { McpNotFoundError, McpOriginConflictError } from "./errors.js";
import { McpEntity } from "./mcp-entity.js";
import type { McpRepository } from "./mcp-repository.js";

export type McpFetcher = (origin: string) => Promise<string>;

/**
 * Application-layer service for MCP operations.
 *
 * v2 (issue #122) renames internal terminology from `name` →
 * `fqn` / `content` → `spec`. The public service surface keeps the
 * `name` arg name on `install` (since that's the wire-side input —
 * the frontmatter / dep-ref form is still origin URI), but uses
 * `fqn` everywhere else.
 */
export class McpService {
  constructor(
    private readonly repo: McpRepository,
    private readonly fetch: McpFetcher,
  ) {}

  async install(name: string, origin: string, rawContent: string): Promise<McpEntity> {
    const entity = McpEntity.create(name, origin, rawContent);
    const existing = await this.repo.findByFqn(entity.fqn);
    if (existing && !sameOrigin(existing.origin, entity.origin)) {
      throw new McpOriginConflictError(entity.fqn, existing.origin, entity.origin);
    }
    await this.repo.add(entity);
    return (await this.repo.findByFqn(entity.fqn)) ?? entity;
  }

  async installFromOrigin(name: string, origin: string): Promise<McpEntity> {
    const content = await this.fetch(origin);
    return this.install(name, origin, content);
  }

  async updateContent(fqn: string, rawContent: string): Promise<McpEntity> {
    const existing = await this.repo.findByFqn(fqn);
    if (!existing) throw new McpNotFoundError(fqn);
    if (!isOriginMutable(existing.origin)) {
      throw new ImmutableOriginError(fqn, existing.origin);
    }
    const updated = existing.withContent(rawContent);
    await this.repo.add(updated);
    return (await this.repo.findByFqn(fqn)) ?? updated;
  }

  async getContent(fqn: string): Promise<string> {
    const entity = await this.repo.findByFqn(fqn);
    if (!entity) throw new McpNotFoundError(fqn);
    return entity.spec;
  }

  async delete(fqn: string): Promise<void> {
    const existing = await this.repo.findByFqn(fqn);
    if (!existing) throw new McpNotFoundError(fqn);
    await this.repo.delete(fqn);
  }

  async get(fqn: string): Promise<McpEntity | null> {
    return this.repo.findByFqn(fqn);
  }

  async getByOrigin(origin: string): Promise<McpEntity | null> {
    return this.repo.findByOrigin(origin);
  }

  async list(): Promise<McpEntity[]> {
    return this.repo.findAll();
  }

  async has(fqn: string): Promise<boolean> {
    return (await this.repo.findByFqn(fqn)) !== null;
  }

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

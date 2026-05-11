import { type EntryFile, normalizeOrigin, parseOrigin } from "@emploke/catalog-fetcher";
import { ImmutableOriginError, isOriginMutable } from "../origin-mutability.js";
import { McpNotFoundError, McpOriginConflictError } from "./errors.js";
import { Mcp } from "./mcp-entity.js";
import type { McpRepository } from "./mcp-repository.js";

/**
 * Application-layer service for MCP operations.
 *
 * Owns:
 *   - origin-conflict invariant (compare existing.origin against new
 *     before delegating to the repo)
 *   - URI fetch dispatch (delegated to the injected fetcher)
 *
 * Does NOT own:
 *   - in-memory index — repository reads are the source of truth
 *     (SQLite-cheap; the FS impl pays a bit more but still bounded)
 *   - write serialization — the repository is the concurrency
 *     boundary (SQLite serializes writers internally; FS impls
 *     would need their own queue)
 *   - HTTP transport — lives in `@emploke/server`
 *   - dependency-graph maintenance — out of scope for MCP-only
 *   - business invariants on individual entities — those live on
 *     `Mcp` itself (name grammar, content well-formedness, identity
 *     immutability)
 *
 * The fetcher dependency is typed as a callback rather than the full
 * `FetcherRegistry` class so tests can inject a stub without pulling
 * in the registry's defaults.
 *
 * Concurrency note: there is a small TOCTOU window in `install`
 * between the existing-entry read and the `add` write. Within a
 * single Node process it's harmless because the gap is microseconds
 * and origin-conflict errors are advisory (caller can retry). For
 * cross-process safety the SQLite impl's atomic `INSERT ... ON
 * CONFLICT` semantics close the window.
 */

/**
 * Fetch a single file's bytes from a URI. The catalog-fetcher's
 * `EntryFile` stream is used for symmetry with skill/agent fetchers
 * (which yield multi-file streams); for MCP we drain to the first
 * yielded file's content.
 */
export type McpFetcher = (origin: string) => AsyncIterable<EntryFile>;

export class McpService {
  constructor(
    private readonly repo: McpRepository,
    private readonly fetch: McpFetcher,
  ) {}

  /**
   * Install an MCP from raw bytes the caller already has in hand.
   *
   * Steps:
   *   1. construct the entity via `Mcp.create` — this validates name,
   *      parses content, injects `_meta.{name, origin}`
   *   2. read any existing entry; if the origins disagree (modulo
   *      normalisation), throw {@link McpOriginConflictError}
   *   3. atomically persist via `repo.add`
   *
   * Returns the persisted entity.
   */
  async install(name: string, origin: string, rawContent: string): Promise<Mcp> {
    const entity = Mcp.create(name, origin, rawContent);
    const existing = await this.repo.findByName(entity.name);
    if (existing && !sameOrigin(existing.origin, entity.origin)) {
      throw new McpOriginConflictError(entity.name, existing.origin, entity.origin);
    }
    await this.repo.add(entity);
    return entity;
  }

  /**
   * Install an MCP by URI: dispatch to the registered fetcher, drain
   * to the first yielded file, then delegate to {@link install}.
   *
   * MCP origins are expected to resolve to a single file. If the
   * fetcher yields multiple files, only the first is used (silently)
   * — the spec doesn't define multi-file MCPs.
   */
  async installFromOrigin(name: string, origin: string): Promise<Mcp> {
    const stream = this.fetch(origin);
    const content = await readSingleFile(stream);
    return this.install(name, origin, content);
  }

  /**
   * Replace an existing MCP's content. The stored origin and name are
   * preserved (re-injected into the new content's `_meta` by
   * `Mcp.withContent`); callers can't change identity via update.
   */
  async updateContent(name: string, rawContent: string): Promise<Mcp> {
    const existing = await this.repo.findByName(name);
    if (!existing) throw new McpNotFoundError(name);
    if (!isOriginMutable(existing.origin)) {
      throw new ImmutableOriginError(name, existing.origin);
    }
    const updated = existing.withContent(rawContent);
    await this.repo.add(updated);
    return updated;
  }

  /**
   * Read the raw stored content (including the `_meta` block) of an
   * installed MCP.
   */
  async getContent(name: string): Promise<string> {
    const entity = await this.repo.findByName(name);
    if (!entity) throw new McpNotFoundError(name);
    return entity.content;
  }

  /**
   * Delete an MCP by name. No dependency-graph check happens here —
   * that's the responsibility of the catalog facade (which knows
   * about skills / agents). For MCP-only use, deletion is unconditional
   * but throws {@link McpNotFoundError} if the entry doesn't exist.
   */
  async delete(name: string): Promise<void> {
    const existing = await this.repo.findByName(name);
    if (!existing) throw new McpNotFoundError(name);
    await this.repo.delete(name);
  }

  /** Look up an installed MCP entity by name, or `null` if absent. */
  async get(name: string): Promise<Mcp | null> {
    return this.repo.findByName(name);
  }

  async getByOrigin(origin: string): Promise<Mcp | null> {
    return this.repo.findByOrigin(origin);
  }

  async list(): Promise<Mcp[]> {
    return this.repo.findAll();
  }

  async has(name: string): Promise<boolean> {
    return (await this.repo.findByName(name)) !== null;
  }

  /** Release the underlying repository's resources. Idempotent. */
  close(): void {
    this.repo.close?.();
  }
}

/**
 * Compare two origin URIs after normalisation. Used by install to
 * detect "is this the same upstream?" so trivial differences in URI
 * encoding don't trigger spurious origin-conflict errors.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return normalizeOrigin(parseOrigin(a)) === normalizeOrigin(parseOrigin(b));
  } catch {
    // If either origin is unparseable, fall back to string equality.
    // The fetcher would reject the unparseable one at fetch time anyway.
    return a === b;
  }
}

/**
 * Drain a fetcher stream to the first yielded file's bytes. MCP
 * origins are single-file by spec; if the upstream yields multiple,
 * we take the first and let the rest fall on the floor (silently).
 */
async function readSingleFile(stream: AsyncIterable<EntryFile>): Promise<string> {
  for await (const file of stream) {
    return file.content.toString("utf8");
  }
  throw new Error("MCP fetcher yielded zero files");
}

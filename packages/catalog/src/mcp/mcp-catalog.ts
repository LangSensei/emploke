import { HasDependents, NotFound } from "../errors.js";
import type { McpRepository } from "../repositories/repository.js";
import type { McpMetadata } from "../types.js";
import { splitMcpName, validateMcpName } from "../validate.js";
import { type McpMeta, parseMcpFile, writeMcpMeta } from "./mcp-frontmatter.js";

/** Per-call options for {@link McpCatalog.install}. */
export interface InstallMcpOpts {
  /**
   * The MCP spec name (`<namespace>/<short>`) to install under. Required
   * — there is no name-derivation from filenames anymore (MCP spec names
   * carry `/` which can't survive a basename round-trip).
   */
  readonly name: string;
  /** Origin URI to record in the inline `_meta.origin`. */
  readonly origin: string;
}

/**
 * Business-logic facade over a {@link McpRepository}.
 *
 * Catalog identity rules (Phase 2):
 *  - Every installed MCP is keyed by its full MCP-spec name
 *    (`<namespace>/<short>`, e.g. `azure/mcp`,
 *    `io.github.user/weather`). The spec name IS the catalog FQN.
 *  - Identity does NOT pass through emploke's scope-mapping system
 *    (L1/L2/L3) — MCP spec names are globally unique by community
 *    convention and need no further namespacing.
 *  - Origin and identity are persisted INSIDE the JSON content as the
 *    inline `_meta: { name, origin }` block — see `mcp-frontmatter.ts`.
 *    No sidecar files.
 *  - On install, emploke shallow-merges its `_meta.{name, origin}` keys
 *    into any existing `_meta` block so reverse-DNS namespaced
 *    sub-objects (e.g. `_meta.io.modelcontextprotocol.registry/...`)
 *    survive untouched.
 */
export class McpCatalog {
  private readonly mcps = new Map<string, McpMetadata>();

  constructor(private readonly repository: McpRepository) {}

  /**
   * Install from raw JSON content. The content's existing structure
   * (client shape: `command`/`args`/`env`/...) is preserved; emploke
   * only injects/overwrites the inline `_meta: { name, origin }` keys
   * via {@link writeMcpMeta}.
   */
  async install(content: string, opts: InstallMcpOpts): Promise<string> {
    validateMcpName(opts.name);
    if (typeof opts.origin !== "string" || opts.origin.length === 0) {
      throw new Error("install requires opts.origin (non-empty string)");
    }
    const meta: McpMeta = { name: opts.name, origin: opts.origin };
    const sourcePath = `mcps:${opts.name}`;
    const merged = writeMcpMeta(content, meta, sourcePath);
    // Defensive parse to confirm the merged result is still valid JSON
    // before we land it on disk.
    parseMcpFile(merged, sourcePath);
    await this.repository.write(opts.name, merged);
    const { namespace, shortName } = splitMcpName(opts.name);
    this.mcps.set(opts.name, {
      name: opts.name,
      namespace,
      shortName,
      origin: opts.origin,
    });
    return opts.name;
  }

  /**
   * Read the on-disk JSON content of an installed MCP as a raw string.
   * Includes the inline `_meta` block — strip via {@link stripMcpMeta}
   * before handing to Copilot CLI.
   */
  async getContent(name: string): Promise<string> {
    validateMcpName(name);
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);
    const content = await this.repository.read(name);
    if (content === null) throw new NotFound("mcp", name);
    return content;
  }

  /**
   * Replace the JSON content of an existing MCP. The new content's
   * `_meta.{name,origin}` is overwritten with the existing entry's
   * meta (caller can't change identity via update; that requires
   * uninstall + reinstall). User-authored client shape and other
   * `_meta.*` keys are preserved.
   */
  async updateContent(name: string, content: string): Promise<void> {
    validateMcpName(name);
    const existing = this.mcps.get(name);
    if (!existing) throw new NotFound("mcp", name);
    const sourcePath = `mcps:${name}`;
    const merged = writeMcpMeta(content, { name, origin: existing.origin }, sourcePath);
    parseMcpFile(merged, sourcePath);
    await this.repository.write(name, merged);
  }

  async remove(name: string, getDependents: (name: string) => string[]): Promise<void> {
    validateMcpName(name);
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);

    const dependents = getDependents(name);
    if (dependents.length > 0) throw new HasDependents(name, dependents);

    await this.repository.delete(name);
    this.mcps.delete(name);
  }

  list(): string[] {
    return [...this.mcps.keys()];
  }

  /** Look up the full metadata record for an installed MCP. */
  get(name: string): McpMetadata | null {
    return this.mcps.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.mcps.has(name);
  }

  async scan(): Promise<{ path: string; reason: string }[]> {
    this.mcps.clear();
    const issues: { path: string; reason: string }[] = [];
    const entries = await this.repository.scan();
    for (const entry of entries) {
      const { name: pathFqn, content, sourcePath } = entry;
      try {
        const { meta } = parseMcpFile(content, sourcePath);
        // Self-consistency: the path-derived name must match the
        // inline `_meta.name`. Mismatch is operator-visible config
        // drift (someone moved the file without updating meta);
        // surface as an issue rather than silently picking one.
        if (meta.name !== pathFqn) {
          issues.push({
            path: sourcePath,
            reason: `inline _meta.name "${meta.name}" doesn't match path-derived name "${pathFqn}"`,
          });
          continue;
        }
        validateMcpName(meta.name);
        const { namespace, shortName } = splitMcpName(meta.name);
        this.mcps.set(meta.name, {
          name: meta.name,
          namespace,
          shortName,
          origin: meta.origin,
        });
      } catch (e) {
        issues.push({ path: sourcePath, reason: (e as Error).message });
      }
    }
    return issues;
  }
}

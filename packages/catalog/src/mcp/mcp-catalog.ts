import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseOrigin, scopeFromOrigin } from "@emploke/catalog-fetcher";
import { HasDependents, NotFound } from "../errors.js";
import { synthesizeOriginFromPath } from "../frontmatter.js";
import type { McpRepository } from "../repositories/repository.js";
import type { McpMetadata } from "../types.js";
import { makeFqn, splitFqn, validateFqn, validateScope, validateShortName } from "../validate.js";

/** Per-call options for {@link McpCatalog.install}. */
export interface InstallMcpOpts {
  /**
   * Override the auto-derived MCP short name. Required when the source
   * file's basename is not a valid kebab-case short name (e.g. when the
   * caller wants `playwright` from a file called `mcp.json`).
   */
  readonly mcpName?: string;
  /**
   * Origin URI to attach to the installed MCP. Defaults to
   * `file:<sourceFile>` when omitted; the route layer / fetchers pass
   * an explicit origin for clean provenance.
   */
  readonly origin?: string;
  /**
   * Override the auto-derived scope. Default is
   * `scopeFromOrigin(parseOrigin(origin))`. Allowed only when `origin`
   * is also a parseable URI; throws otherwise.
   */
  readonly scope?: string;
}

/**
 * Business-logic facade over a {@link McpRepository}.
 *
 * Catalog identity rules (post-#39):
 *  - Every installed MCP is keyed by its FQN (`<scope>/<short-name>`).
 *  - The short name defaults to the source file's basename (sans `.json`),
 *    overridable via `opts.mcpName`. It must satisfy the kebab-case
 *    short-name grammar — slashes inside the short name are rejected.
 *  - The scope is derived from the install origin (which defaults to
 *    `file:<sourceFile>`, yielding scope `local`).
 *
 * Origin metadata is persisted by the repository implementation (FS uses
 * a `<name>.origin.json` sidecar; in-memory keeps it on a parallel map).
 */
export class McpCatalog {
  private readonly mcps = new Map<string, McpMetadata>();

  constructor(private readonly repository: McpRepository) {}

  async install(sourceFile: string, opts: InstallMcpOpts = {}): Promise<string> {
    const content = await readFile(sourceFile, "utf8");
    JSON.parse(content);

    const shortName = opts.mcpName ?? basename(sourceFile, ".json");
    validateShortName(shortName);

    const origin = opts.origin ?? synthesizeOriginFromPath(sourceFile);
    let scope: string;
    if (opts.scope !== undefined) {
      validateScope(opts.scope);
      scope = opts.scope;
    } else {
      scope = scopeFromOrigin(parseOrigin(origin));
    }

    const fqn = makeFqn(scope, shortName);
    await this.repository.write(fqn, content, { origin });
    this.mcps.set(fqn, { name: fqn, shortName, scope, origin });
    return fqn;
  }

  /**
   * Install from raw JSON content (no on-disk source). Used by the
   * pluggable-fetcher path: the fetcher streams a single JSON file from
   * the remote, the route reads it into memory, and we install without
   * round-tripping to disk. `opts.mcpName` is required (no source file
   * to derive a basename from).
   */
  async installFromContent(content: string, opts: InstallMcpOpts = {}): Promise<string> {
    JSON.parse(content);
    if (!opts.mcpName) {
      throw new Error("installFromContent requires opts.mcpName (no source file to infer from)");
    }
    validateShortName(opts.mcpName);
    if (!opts.origin) {
      throw new Error("installFromContent requires opts.origin");
    }

    let scope: string;
    if (opts.scope !== undefined) {
      validateScope(opts.scope);
      scope = opts.scope;
    } else {
      scope = scopeFromOrigin(parseOrigin(opts.origin));
    }

    const fqn = makeFqn(scope, opts.mcpName);
    await this.repository.write(fqn, content, { origin: opts.origin });
    this.mcps.set(fqn, { name: fqn, shortName: opts.mcpName, scope, origin: opts.origin });
    return fqn;
  }

  /**
   * Read the on-disk JSON content of an installed MCP as a raw string.
   * The server returns the bytes verbatim; the client gets to display whatever
   * formatting the user wrote, not a re-serialized canonical form.
   */
  async getContent(name: string): Promise<string> {
    validateFqn(name);
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);
    const content = await this.repository.read(name);
    if (content === null) throw new NotFound("mcp", name);
    return content;
  }

  /**
   * Replace the JSON content of an existing MCP. The new content must be valid
   * JSON; we validate by attempting to parse but write the original string so
   * user formatting is preserved. Origin is preserved as-is.
   */
  async updateContent(name: string, content: string): Promise<void> {
    validateFqn(name);
    const existing = this.mcps.get(name);
    if (!existing) throw new NotFound("mcp", name);

    try {
      JSON.parse(content);
    } catch (cause) {
      throw new Error(`invalid JSON: ${(cause as Error).message}`);
    }

    await this.repository.write(name, content, { origin: existing.origin });
  }

  async remove(name: string, getDependents: (name: string) => string[]): Promise<void> {
    validateFqn(name);
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
      const { name: fqn, content, sourcePath } = entry;
      try {
        JSON.parse(content);
        // Repos that can't persist origin per-entry (in-memory legacy) report
        // it as undefined; synthesise from sourcePath so every catalogue
        // entry carries an origin.
        const origin = entry.origin ?? synthesizeOriginFromPath(sourcePath);
        const { scope, name } = splitFqn(fqn);
        this.mcps.set(fqn, { name: fqn, shortName: name, scope, origin });
      } catch (e) {
        issues.push({ path: sourcePath, reason: (e as Error).message });
      }
    }
    return issues;
  }
}

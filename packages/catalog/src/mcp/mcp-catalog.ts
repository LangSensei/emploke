import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { HasDependents, NotFound } from "../errors.js";
import type { McpRepository } from "../repositories/repository.js";
import { validateMcpName } from "../validate.js";

/** Business-logic facade over a {@link McpRepository}. */
export class McpCatalog {
  private readonly mcps = new Set<string>();

  constructor(private readonly repository: McpRepository) {}

  async install(sourceFile: string, mcpName?: string): Promise<string> {
    const content = await readFile(sourceFile, "utf8");
    // Validate JSON before installing (we don't reformat — preserve user's
    // whitespace / comments / etc. byte-for-byte).
    JSON.parse(content);
    // For scoped MCPs (e.g. io.playwright/mcp), mcpName must be provided
    // explicitly. Auto-inference only works for unscoped names derived from
    // the source filename. Use path.basename so this works on both Windows
    // and POSIX paths.
    const name = mcpName ?? basename(sourceFile, ".json");
    validateMcpName(name);

    await this.repository.write(name, content);
    this.mcps.add(name);
    return name;
  }

  /**
   * Read the on-disk JSON content of an installed MCP as a raw string.
   * The server returns the bytes verbatim; the client gets to display whatever
   * formatting the user wrote, not a re-serialized canonical form.
   */
  async getContent(name: string): Promise<string> {
    // Defense-in-depth: validate before composing the on-disk path.
    // updateContent / remove already validate; getContent was the last gap
    // before the repo seam was added. The repo also validates, but rejecting
    // here preserves NotFound semantics for invalid names.
    validateMcpName(name);
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);
    const content = await this.repository.read(name);
    if (content === null) throw new NotFound("mcp", name);
    return content;
  }

  /**
   * Replace the JSON content of an existing MCP. The new content must be valid
   * JSON; we validate by attempting to parse but write the original string so
   * user formatting is preserved.
   */
  async updateContent(name: string, content: string): Promise<void> {
    validateMcpName(name);
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);

    try {
      JSON.parse(content);
    } catch (cause) {
      throw new Error(`invalid JSON: ${(cause as Error).message}`);
    }

    await this.repository.write(name, content);
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
    return [...this.mcps];
  }

  has(name: string): boolean {
    return this.mcps.has(name);
  }

  /**
   * Returns the on-disk path for an installed MCP, or `null` if either:
   *   - the MCP isn't installed, or
   *   - the underlying repository isn't file-backed (e.g. an in-memory test
   *     repository).
   */
  getPath(name: string): string | null {
    if (!this.mcps.has(name)) return null;
    if (!this.repository.pathFor) return null;
    return this.repository.pathFor(name);
  }

  async scan(): Promise<{ path: string; reason: string }[]> {
    this.mcps.clear();
    const issues: { path: string; reason: string }[] = [];
    const entries = await this.repository.scan();
    for (const { name, content, sourcePath } of entries) {
      try {
        JSON.parse(content);
        this.mcps.add(name);
      } catch (e) {
        issues.push({ path: sourcePath, reason: (e as Error).message });
      }
    }
    return issues;
  }
}

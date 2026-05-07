import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../atomic.js";
import { HasDependents, NotFound } from "../errors.js";

import { nameToPath, validateMcpName } from "../validate.js";

export class McpStore {
  private readonly mcps = new Set<string>();

  constructor(private readonly catalogDir: string) {}

  private get baseDir() {
    return join(this.catalogDir, "mcps");
  }

  async install(sourceFile: string, mcpName?: string): Promise<string> {
    const content = await readFile(sourceFile, "utf8");
    // Validate JSON before installing (we don't reformat — preserve user's
    // whitespace / comments / etc. byte-for-byte).
    JSON.parse(content);
    // For scoped MCPs (e.g. io.playwright/mcp), mcpName must be provided explicitly.
    // Auto-inference only works for unscoped names derived from filename.
    // Use path.basename so this works on both Windows (\) and POSIX (/) paths.
    const name = mcpName ?? basename(sourceFile, ".json");
    validateMcpName(name);

    const destFile = join(this.baseDir, `${nameToPath(name)}.json`);
    await mkdir(dirname(destFile), { recursive: true });
    await writeFile(destFile, content, "utf8");
    this.mcps.add(name);
    return name;
  }

  /**
   * Read the on-disk JSON content of an installed MCP as a raw string.
   * Server returns the bytes verbatim; the client gets to display whatever
   * formatting the user wrote, not a re-serialized canonical form.
   */
  async getContent(name: string): Promise<string> {
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);
    const destFile = join(this.baseDir, `${nameToPath(name)}.json`);
    return readFile(destFile, "utf8");
  }

  /**
   * Replace the JSON content of an existing MCP atomically. The new content
   * must be valid JSON; we validate by attempting to parse but write the
   * original string so user formatting is preserved.
   */
  async updateContent(name: string, content: string): Promise<void> {
    validateMcpName(name);
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);

    // Validate JSON shape before touching disk.
    try {
      JSON.parse(content);
    } catch (cause) {
      throw new Error(`invalid JSON: ${(cause as Error).message}`);
    }

    const destFile = join(this.baseDir, `${nameToPath(name)}.json`);
    await writeFile(destFile, content, "utf8");
  }

  async remove(name: string, getDependents: (name: string) => string[]): Promise<void> {
    validateMcpName(name);
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);

    const dependents = getDependents(name);
    if (dependents.length > 0) throw new HasDependents(name, dependents);

    const destFile = join(this.baseDir, `${nameToPath(name)}.json`);
    await rm(destFile, { force: true });
    this.mcps.delete(name);
  }

  getPath(name: string): string | null {
    if (!this.mcps.has(name)) return null;
    return join(this.baseDir, `${nameToPath(name)}.json`);
  }

  list(): string[] {
    return [...this.mcps];
  }

  has(name: string): boolean {
    return this.mcps.has(name);
  }

  async scan(): Promise<{ path: string; reason: string }[]> {
    this.mcps.clear();
    const issues: { path: string; reason: string }[] = [];
    if (!(await pathExists(this.baseDir))) return issues;
    await this.scanDir(this.baseDir, null, issues);
    return issues;
  }

  private async scanDir(
    dir: string,
    scope: string | null,
    issues: { path: string; reason: string }[],
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const baseName = entry.name.replace(/\.json$/, "");
        const fullName = scope ? `${scope}/${baseName}` : baseName;
        try {
          const content = await readFile(join(dir, entry.name), "utf8");
          JSON.parse(content);
          this.mcps.add(fullName);
        } catch (e) {
          issues.push({ path: join(dir, entry.name), reason: (e as Error).message });
        }
      } else if (entry.isDirectory() && scope === null) {
        await this.scanDir(join(dir, entry.name), entry.name, issues);
      }
    }
  }
}

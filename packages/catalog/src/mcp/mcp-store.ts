import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJsonFile, pathExists } from "../atomic.js";
import { HasDependents, NotFound } from "../errors.js";
import type { CatalogEvent, EventBus } from "../types.js";
import { nameToPath, validateMcpName } from "../validate.js";

export class McpStore {
  private readonly mcps = new Set<string>();

  constructor(
    private readonly catalogDir: string,
    private readonly events: EventBus<CatalogEvent>,
  ) {}

  private get baseDir() {
    return join(this.catalogDir, "mcps");
  }

  async install(sourceFile: string, mcpName?: string): Promise<string> {
    const content = await readFile(sourceFile, "utf8");
    const parsed = JSON.parse(content);
    // For scoped MCPs (e.g. io.playwright/mcp), mcpName must be provided explicitly.
    // Auto-inference only works for unscoped names derived from filename.
    const name =
      mcpName ??
      sourceFile
        .split("/")
        .pop()!
        .replace(/\.json$/, "");
    validateMcpName(name);

    const destFile = join(this.baseDir, `${nameToPath(name)}.json`);
    const destDir = destFile.substring(0, destFile.lastIndexOf("/"));
    await mkdir(destDir, { recursive: true });
    const exists = this.mcps.has(name);
    await atomicWriteJsonFile(parsed, destFile);
    this.mcps.add(name);

    this.events.publish({
      type: exists ? "McpUpdated" : "McpInstalled",
      name,
      path: destFile,
      at: new Date(),
    });
    return name;
  }

  async remove(name: string, getDependents: (name: string) => string[]): Promise<void> {
    validateMcpName(name);
    if (!this.mcps.has(name)) throw new NotFound("mcp", name);

    const dependents = getDependents(name);
    if (dependents.length > 0) throw new HasDependents(name, dependents);

    const destFile = join(this.baseDir, `${nameToPath(name)}.json`);
    await rm(destFile, { force: true });
    this.mcps.delete(name);
    this.events.publish({ type: "McpUninstalled", name, at: new Date() });
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

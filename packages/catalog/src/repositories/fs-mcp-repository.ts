import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirP } from "@emploke/storage";
import { pathExists } from "../atomic.js";
import { nameToPath, validateMcpName } from "../validate.js";
import type { McpRepoEntry, McpRepository } from "./repository.js";

export class FsMcpRepository implements McpRepository {
  private readonly baseDir: string;

  constructor(catalogDir: string) {
    this.baseDir = join(catalogDir, "mcps");
  }

  async read(name: string): Promise<string | null> {
    validateMcpName(name);
    const file = this.fileFor(name);
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async write(name: string, content: string): Promise<void> {
    validateMcpName(name);
    const file = this.fileFor(name);
    await mkdirP(dirname(file));
    await writeFile(file, content, "utf8");
  }

  async delete(name: string): Promise<void> {
    validateMcpName(name);
    await rm(this.fileFor(name), { force: true });
  }

  async scan(): Promise<McpRepoEntry[]> {
    const out: McpRepoEntry[] = [];
    if (!(await pathExists(this.baseDir))) return out;
    await this.scanDir(this.baseDir, /*scope*/ null, out);
    return out;
  }

  /** Path-composition for the on-disk JSON file. Internal — not part of the
   * `McpRepository` contract; never leak to higher layers (consumers must
   * use `read(name)` to get the content directly). */
  private fileFor(name: string): string {
    return join(this.baseDir, `${nameToPath(name)}.json`);
  }

  private async scanDir(dir: string, scope: string | null, out: McpRepoEntry[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const baseName = entry.name.replace(/\.json$/, "");
        const fullName = scope ? `${scope}/${baseName}` : baseName;
        const sourcePath = join(dir, entry.name);
        const content = await readFile(sourcePath, "utf8");
        out.push({ name: fullName, content, sourcePath });
      } else if (entry.isDirectory() && scope === null) {
        await this.scanDir(join(dir, entry.name), entry.name, out);
      }
    }
  }
}

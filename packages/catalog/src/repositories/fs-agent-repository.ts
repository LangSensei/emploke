import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdirP, replaceDirAtomic, safeStat, writeFileAtomic } from "@emploke/fs";
import { nameToPath, validateFqn } from "../validate.js";
import { installStreamToDir, walkEntryDir } from "./entries-helpers.js";
import type { AgentRepository, CatalogEntryFile, DocumentRepoEntry } from "./repository.js";

export class FsAgentRepository implements AgentRepository {
  private readonly baseDir: string;

  constructor(catalogDir: string) {
    this.baseDir = join(catalogDir, "agents");
  }

  async read(name: string): Promise<string | null> {
    validateFqn(name);
    const file = join(this.baseDir, nameToPath(name), "AGENTS.md");
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async write(name: string, content: string): Promise<void> {
    validateFqn(name);
    const dir = join(this.baseDir, nameToPath(name));
    await mkdirP(dir);
    // Atomic write: a crash mid-update must not leave a partial AGENTS.md
    // (corrupt frontmatter would break every subsequent scan). Mirrors
    // the same fix applied to FsSkillRepository / FsMcpRepository in
    // PR #41's review-fix commit; agent was missed.
    await writeFileAtomic(join(dir, "AGENTS.md"), content);
  }

  async installFromDir(name: string, sourceDir: string): Promise<void> {
    validateFqn(name);
    const dest = join(this.baseDir, nameToPath(name));
    await replaceDirAtomic(sourceDir, dest);
  }

  async install(name: string, stream: AsyncIterable<CatalogEntryFile>): Promise<void> {
    validateFqn(name);
    const dest = join(this.baseDir, nameToPath(name));
    await installStreamToDir(dest, stream);
  }

  async delete(name: string): Promise<void> {
    validateFqn(name);
    const dir = join(this.baseDir, nameToPath(name));
    await rm(dir, { recursive: true, force: true });
  }

  async scan(): Promise<DocumentRepoEntry[]> {
    const out: DocumentRepoEntry[] = [];
    if ((await safeStat(this.baseDir)) === null) return out;
    await this.scanDir(this.baseDir, /*scope*/ null, out);
    return out;
  }

  entries(name: string): AsyncIterable<CatalogEntryFile> {
    validateFqn(name);
    return walkEntryDir("agent", name, join(this.baseDir, nameToPath(name)));
  }

  private async scanDir(
    dir: string,
    scope: string | null,
    out: DocumentRepoEntry[],
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(dir, entry.name);
      const agentMd = join(entryPath, "AGENTS.md");
      if ((await safeStat(agentMd)) !== null) {
        const content = await readFile(agentMd, "utf8");
        out.push({ content, sourcePath: agentMd });
      } else if (scope === null) {
        await this.scanDir(entryPath, entry.name, out);
      }
    }
  }
}

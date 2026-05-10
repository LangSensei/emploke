import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirP, safeStat, writeFileAtomic } from "@emploke/fs";
import { nameToPath, validateFqn } from "../validate.js";
import { installStreamToDir, walkEntryDir } from "./entries-helpers.js";
import type { AgentRepository, CatalogEntryFile, DocumentRepoEntry } from "./repository.js";

export class FsAgentRepository implements AgentRepository {
  private readonly baseDir: string;
  private readonly tmpRoot: string;

  constructor(catalogDir: string) {
    this.baseDir = join(catalogDir, "agents");
    // See FsSkillRepository: shared `<catalogDir>/.tmp` for atomic installs.
    this.tmpRoot = join(catalogDir, ".tmp");
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
    // (corrupt frontmatter would break every subsequent scan).
    await writeFileAtomic(join(dir, "AGENTS.md"), content);
  }

  async install(name: string, stream: AsyncIterable<CatalogEntryFile>): Promise<void> {
    validateFqn(name);
    const dest = join(this.baseDir, nameToPath(name));
    await installStreamToDir(this.tmpRoot, dest, stream);
  }

  async delete(name: string): Promise<void> {
    validateFqn(name);
    const dir = join(this.baseDir, nameToPath(name));
    await rm(dir, { recursive: true, force: true });
    // See FsSkillRepository.delete: clean up empty scope dir.
    const scopeDir = dirname(dir);
    if (scopeDir !== this.baseDir) {
      try {
        await rm(scopeDir, { recursive: false });
      } catch {
        // Non-empty — leave it.
      }
    }
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
      // See FsSkillRepository.scanDir for the dot-prefix / inner-dot rules.
      if (entry.name.startsWith(".")) continue;
      if (scope !== null && entry.name.includes(".")) continue;
      const entryPath = join(dir, entry.name);
      const agentMd = join(entryPath, "AGENTS.md");
      if ((await safeStat(agentMd)) !== null) {
        if (scope === null) continue;
        const content = await readFile(agentMd, "utf8");
        out.push({ name: `${scope}/${entry.name}`, content, sourcePath: agentMd });
      } else if (scope === null) {
        await this.scanDir(entryPath, entry.name, out);
      }
    }
  }
}

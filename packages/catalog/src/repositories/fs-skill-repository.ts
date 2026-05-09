import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdirP } from "@emploke/storage";
import { atomicReplaceDir, pathExists } from "../atomic.js";
import { nameToPath, validateName } from "../validate.js";
import { walkEntryDir } from "./entries-helpers.js";
import type { CatalogEntryFile, DocumentRepoEntry, SkillRepository } from "./repository.js";

export class FsSkillRepository implements SkillRepository {
  private readonly baseDir: string;

  constructor(catalogDir: string) {
    this.baseDir = join(catalogDir, "skills");
  }

  async read(name: string): Promise<string | null> {
    validateName(name);
    const file = join(this.baseDir, nameToPath(name), "SKILL.md");
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async write(name: string, content: string): Promise<void> {
    validateName(name);
    const dir = join(this.baseDir, nameToPath(name));
    await mkdirP(dir);
    await writeFile(join(dir, "SKILL.md"), content, "utf8");
  }

  async installFromDir(name: string, sourceDir: string): Promise<void> {
    validateName(name);
    const dest = join(this.baseDir, nameToPath(name));
    await atomicReplaceDir(sourceDir, dest);
  }

  async delete(name: string): Promise<void> {
    validateName(name);
    const dir = join(this.baseDir, nameToPath(name));
    await rm(dir, { recursive: true, force: true });
  }

  async scan(): Promise<DocumentRepoEntry[]> {
    const out: DocumentRepoEntry[] = [];
    if (!(await pathExists(this.baseDir))) return out;
    await this.scanDir(this.baseDir, /*scope*/ null, out);
    return out;
  }

  entries(name: string): AsyncIterable<CatalogEntryFile> {
    validateName(name);
    return walkEntryDir("skill", name, join(this.baseDir, nameToPath(name)));
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
      const skillMd = join(entryPath, "SKILL.md");
      if (await pathExists(skillMd)) {
        const content = await readFile(skillMd, "utf8");
        out.push({ content, sourcePath: skillMd });
      } else if (scope === null) {
        await this.scanDir(entryPath, entry.name, out);
      }
    }
  }
}

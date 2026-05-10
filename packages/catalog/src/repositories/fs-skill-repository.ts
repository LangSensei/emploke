import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirP, safeStat, writeFileAtomic } from "@emploke/fs";
import { nameToPath, validateFqn } from "../validate.js";
import { installStreamToDir, walkEntryDir } from "./entries-helpers.js";
import type { CatalogEntryFile, DocumentRepoEntry, SkillRepository } from "./repository.js";

export class FsSkillRepository implements SkillRepository {
  private readonly baseDir: string;
  private readonly tmpRoot: string;

  constructor(catalogDir: string) {
    this.baseDir = join(catalogDir, "skills");
    // All in-progress installs land here, then atomic-rename into baseDir.
    // See entries-helpers.installStreamToDir for the atomic write contract;
    // the catalog's open() boot path sweeps this dir to clean crash leftovers.
    this.tmpRoot = join(catalogDir, ".tmp");
  }

  async read(name: string): Promise<string | null> {
    validateFqn(name);
    const file = join(this.baseDir, nameToPath(name), "SKILL.md");
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
    // Atomic write: see FsAgentRepository.write for rationale.
    await writeFileAtomic(join(dir, "SKILL.md"), content);
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
    // Best-effort: clean up the now-empty scope dir so future scans
    // don't have to skip empty stubs (and so `scope/` doesn't visually
    // imply that scope is still in use).
    const scopeDir = dirname(dir);
    if (scopeDir !== this.baseDir) {
      try {
        await rm(scopeDir, { recursive: false });
      } catch {
        // Non-empty (other entries under same scope) — leave it.
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
      // Always skip dot-prefixed dirs (`.git`, `.DS_Store`, future hidden
      // metadata). The catalog's own `.tmp` and `.lock` live at
      // <catalogDir> (not under skills/), so this is mostly belt-and-braces
      // for user-side accidents.
      if (entry.name.startsWith(".")) continue;
      // At the inner (name) level: shortName grammar is kebab-case (no
      // dots), so any dot in the name signals a stray dir — typically a
      // crashed-install leftover from an older layout. Skip silently.
      if (scope !== null && entry.name.includes(".")) continue;
      const entryPath = join(dir, entry.name);
      const skillMd = join(entryPath, "SKILL.md");
      if ((await safeStat(skillMd)) !== null) {
        // FQN = path-derived scope/name. Top-level entries (no scope dir)
        // would be malformed; the post-#39 layout always has a scope
        // segment. Skip silently — the catalog layer can't represent a
        // single-segment FQN.
        if (scope === null) continue;
        const content = await readFile(skillMd, "utf8");
        out.push({ name: `${scope}/${entry.name}`, content, sourcePath: skillMd });
      } else if (scope === null) {
        await this.scanDir(entryPath, entry.name, out);
      }
    }
  }
}

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentRepoEntry, SkillRepository } from "./repository.js";

/** In-memory `SkillRepository` for fast unit tests. See InMemoryAgentRepository. */
export class InMemorySkillRepository implements SkillRepository {
  private readonly entries = new Map<string, Map<string, string>>();

  async read(name: string): Promise<string | null> {
    return this.entries.get(name)?.get("SKILL.md") ?? null;
  }

  async write(name: string, content: string): Promise<void> {
    const files = this.entries.get(name) ?? new Map<string, string>();
    files.set("SKILL.md", content);
    this.entries.set(name, files);
  }

  async installFromDir(name: string, sourceDir: string): Promise<void> {
    const files = new Map<string, string>();
    await this.copyTree(sourceDir, "", files);
    this.entries.set(name, files);
  }

  async delete(name: string): Promise<void> {
    this.entries.delete(name);
  }

  async scan(): Promise<DocumentRepoEntry[]> {
    const out: DocumentRepoEntry[] = [];
    for (const [name, files] of this.entries) {
      const md = files.get("SKILL.md");
      if (md !== undefined) {
        out.push({ content: md, sourcePath: `memory:skills/${name}/SKILL.md` });
      }
    }
    return out;
  }

  files(name: string): ReadonlyMap<string, string> | null {
    return this.entries.get(name) ?? null;
  }

  private async copyTree(rootDir: string, rel: string, files: Map<string, string>): Promise<void> {
    const dir = rel ? join(rootDir, rel) : rootDir;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await this.copyTree(rootDir, childRel, files);
      } else if (e.isFile()) {
        const s = await stat(abs);
        if (s.size > 1_048_576) continue;
        files.set(childRel, await readFile(abs, "utf8"));
      }
    }
  }
}

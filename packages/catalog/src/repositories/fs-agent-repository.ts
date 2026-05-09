import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdirP } from "@emploke/storage";
import { atomicReplaceDir, pathExists } from "../atomic.js";
import { nameToPath, validateName } from "../validate.js";
import type { AgentRepository, DocumentRepoEntry } from "./repository.js";

export class FsAgentRepository implements AgentRepository {
  private readonly baseDir: string;

  constructor(catalogDir: string) {
    this.baseDir = join(catalogDir, "agents");
  }

  async read(name: string): Promise<string | null> {
    validateName(name);
    const file = join(this.baseDir, nameToPath(name), "AGENTS.md");
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
    await writeFile(join(dir, "AGENTS.md"), content, "utf8");
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
      if (await pathExists(agentMd)) {
        const content = await readFile(agentMd, "utf8");
        out.push({ content, sourcePath: agentMd });
      } else if (scope === null) {
        await this.scanDir(entryPath, entry.name, out);
      }
    }
  }
}

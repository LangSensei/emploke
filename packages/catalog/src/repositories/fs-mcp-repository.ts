import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirP, safeStat, writeFileAtomic } from "@emploke/fs";
import { splitMcpName, validateMcpName } from "../validate.js";
import type { McpRepoEntry, McpRepository } from "./repository.js";

/**
 * Filesystem-backed `McpRepository`.
 *
 * Layout (per MCP spec FQN `<namespace>/<short>`):
 *   `<catalogDir>/mcps/<namespace>/<short>.json`
 *
 * The full MCP spec name is the on-disk identity — `azure/mcp` lives at
 * `mcps/azure/mcp.json`, `io.github.user/weather` at
 * `mcps/io.github.user/weather.json`. Two-level layout matches skills /
 * agents and gives visual grouping per namespace.
 *
 * No origin sidecar — origin is persisted inside the JSON body as
 * `_meta.origin` (see `mcp-frontmatter.ts`). Backends only need to
 * persist one blob per MCP.
 */
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
    // Atomic write: a partial JSON file would crash every downstream
    // consumer (resolver, runtime provision, dashboard read).
    await writeFileAtomic(file, content);
  }

  async delete(name: string): Promise<void> {
    validateMcpName(name);
    await rm(this.fileFor(name), { force: true });
    // Best-effort: clean up the namespace dir if empty after delete so
    // future scans don't trip over empty <ns>/ stubs.
    const nsDir = dirname(this.fileFor(name));
    try {
      await rm(nsDir, { recursive: false });
    } catch {
      // Non-empty dir — keep it. Other ENOENT / EACCES — ignore.
    }
  }

  async scan(): Promise<McpRepoEntry[]> {
    const out: McpRepoEntry[] = [];
    if ((await safeStat(this.baseDir)) === null) return out;
    await this.scanDir(this.baseDir, /*namespace*/ null, out);
    return out;
  }

  private fileFor(name: string): string {
    const { namespace, shortName } = splitMcpName(name);
    return join(this.baseDir, namespace, `${shortName}.json`);
  }

  private async scanDir(dir: string, namespace: string | null, out: McpRepoEntry[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        if (namespace === null) {
          // Top-level *.json files don't fit the two-level layout;
          // skip them quietly. The catalog layer surfaces malformed
          // entries via its own scan-issues mechanism if needed.
          continue;
        }
        const shortName = entry.name.replace(/\.json$/, "");
        const fullName = `${namespace}/${shortName}`;
        const sourcePath = join(dir, entry.name);
        const content = await readFile(sourcePath, "utf8");
        out.push({ name: fullName, content, sourcePath });
      } else if (entry.isDirectory() && namespace === null) {
        await this.scanDir(join(dir, entry.name), entry.name, out);
      }
    }
  }
}

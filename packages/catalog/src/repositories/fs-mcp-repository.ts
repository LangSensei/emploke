import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirP, writeFileAtomic } from "@emploke/fs";
import { pathExists } from "../atomic.js";
import { nameToPath, validateFqn } from "../validate.js";
import type { McpRepoEntry, McpRepository, McpWriteOpts } from "./repository.js";

const ORIGIN_SIDECAR_SUFFIX = ".origin.json";

/**
 * Filesystem-backed `McpRepository`.
 *
 * Layout (per FQN `<scope>/<short>`):
 *   `<catalogDir>/mcps/<scope>/<short>.json`           — JSON content
 *   `<catalogDir>/mcps/<scope>/<short>.origin.json`    — `{ "origin": "..." }`
 *
 * The `.origin.json` sidecar is the only place MCP origin lives — MCPs are
 * pure JSON without frontmatter, so we can't piggyback on the content
 * itself. The sidecar is plain `{ "origin": <uri> }` and is missing-tolerant
 * (catalog layer synthesises `file:<sourcePath>` when absent).
 */
export class FsMcpRepository implements McpRepository {
  private readonly baseDir: string;

  constructor(catalogDir: string) {
    this.baseDir = join(catalogDir, "mcps");
  }

  async read(name: string): Promise<string | null> {
    validateFqn(name);
    const file = this.fileFor(name);
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async write(name: string, content: string, opts: McpWriteOpts = {}): Promise<void> {
    validateFqn(name);
    const file = this.fileFor(name);
    await mkdirP(dirname(file));
    // Atomic write: a partial JSON file would crash every downstream
    // consumer (resolver, runtime provision, dashboard read).
    await writeFileAtomic(file, content);
    if (opts.origin !== undefined) {
      const sidecar = this.sidecarFor(name);
      await writeFileAtomic(sidecar, `${JSON.stringify({ origin: opts.origin }, null, 2)}\n`);
    }
  }

  async delete(name: string): Promise<void> {
    validateFqn(name);
    await rm(this.fileFor(name), { force: true });
    await rm(this.sidecarFor(name), { force: true });
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

  private sidecarFor(name: string): string {
    return join(this.baseDir, `${nameToPath(name)}${ORIGIN_SIDECAR_SUFFIX}`);
  }

  private async scanDir(dir: string, scope: string | null, out: McpRepoEntry[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        // Skip sidecar files; they're surfaced inline with their main entry.
        if (entry.name.endsWith(ORIGIN_SIDECAR_SUFFIX)) continue;
        const baseName = entry.name.replace(/\.json$/, "");
        // After #39, MCPs are FQN-keyed. Scoped paths produce
        // `<scope>/<short>`; legacy unscoped JSON files at the top of
        // `mcps/` get an implicit `local` scope so they remain readable
        // without a one-shot migration.
        const fullName = scope ? `${scope}/${baseName}` : `local/${baseName}`;
        const sourcePath = join(dir, entry.name);
        const content = await readFile(sourcePath, "utf8");
        const origin = await this.readSidecar(join(dir, `${baseName}${ORIGIN_SIDECAR_SUFFIX}`));
        out.push(origin === null ? { name: fullName, content, sourcePath } : { name: fullName, content, sourcePath, origin });
      } else if (entry.isDirectory() && scope === null) {
        await this.scanDir(join(dir, entry.name), entry.name, out);
      }
    }
  }

  private async readSidecar(path: string): Promise<string | null> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { origin?: unknown };
      return typeof parsed.origin === "string" ? parsed.origin : null;
    } catch {
      // Missing or malformed sidecar — treat as "no origin recorded";
      // the catalog layer will synthesise from sourcePath.
      return null;
    }
  }
}

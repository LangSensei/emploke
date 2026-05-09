import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { NotFound } from "../errors.js";
import type { AgentRepository, CatalogEntryFile, DocumentRepoEntry } from "./repository.js";

/**
 * In-memory `AgentRepository` for fast unit tests.
 *
 * `installFromDir` copies AGENTS.md plus every regular file in the source
 * directory into memory; this matches the on-disk impl closely enough for
 * tests that don't care about cross-process atomicity.
 */
export class InMemoryAgentRepository implements AgentRepository {
  private readonly storedEntries = new Map<string, Map<string, Buffer>>();

  async read(name: string): Promise<string | null> {
    const buf = this.storedEntries.get(name)?.get("AGENTS.md");
    return buf !== undefined ? buf.toString("utf8") : null;
  }

  async write(name: string, content: string): Promise<void> {
    const files = this.storedEntries.get(name) ?? new Map<string, Buffer>();
    files.set("AGENTS.md", Buffer.from(content, "utf8"));
    this.storedEntries.set(name, files);
  }

  async installFromDir(name: string, sourceDir: string): Promise<void> {
    const files = new Map<string, Buffer>();
    await this.copyTree(sourceDir, "", files);
    this.storedEntries.set(name, files);
  }

  async install(name: string, stream: AsyncIterable<CatalogEntryFile>): Promise<void> {
    const files = new Map<string, Buffer>();
    for await (const f of stream) {
      const segments = f.relPath.split("/").filter((s) => s.length > 0);
      if (segments.length === 0) continue;
      if (segments.some((s) => s === "..") || f.relPath.startsWith("/")) {
        throw new Error(`unsafe relPath in stream: ${f.relPath}`);
      }
      files.set(segments.join("/"), f.content);
    }
    this.storedEntries.set(name, files);
  }

  async delete(name: string): Promise<void> {
    this.storedEntries.delete(name);
  }

  async scan(): Promise<DocumentRepoEntry[]> {
    const out: DocumentRepoEntry[] = [];
    for (const [name, files] of this.storedEntries) {
      const md = files.get("AGENTS.md");
      if (md !== undefined) {
        out.push({ content: md.toString("utf8"), sourcePath: `memory:agents/${name}/AGENTS.md` });
      }
    }
    return out;
  }

  async *entries(name: string): AsyncIterable<CatalogEntryFile> {
    const files = this.storedEntries.get(name);
    if (!files) throw new NotFound("agent", name);
    for (const [relPath, content] of files) yield { relPath, content };
  }

  /** Test helper: list raw file payloads for `name`. */
  files(name: string): ReadonlyMap<string, Buffer> | null {
    return this.storedEntries.get(name) ?? null;
  }

  private async copyTree(rootDir: string, rel: string, files: Map<string, Buffer>): Promise<void> {
    const dir = rel ? join(rootDir, rel) : rootDir;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await this.copyTree(rootDir, childRel, files);
      } else if (e.isFile()) {
        const s = await stat(abs);
        // Same 50 MB cap as the FS walker (`entries-helpers.ts`). Tests
        // that pass with InMemory must behave identically with FS in
        // production — diverging caps let large-file regressions hide.
        if (s.size > 50 * 1024 * 1024) continue;
        files.set(childRel, await readFile(abs));
      }
    }
  }
}

import { NotFound } from "../errors.js";
import type { AgentRepository, CatalogEntryFile, DocumentRepoEntry } from "./repository.js";

/** In-memory `AgentRepository` for fast unit tests. */
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
        out.push({
          name,
          content: md.toString("utf8"),
          sourcePath: `memory:agents/${name}/AGENTS.md`,
        });
      }
    }
    return out;
  }

  async *entries(name: string): AsyncIterable<CatalogEntryFile> {
    const files = this.storedEntries.get(name);
    if (!files) throw new NotFound("agent", name);
    for (const [relPath, content] of files) yield { relPath, content };
  }

  /** Test-only escape hatch for seeding extra files alongside AGENTS.md. */
  files(name: string): ReadonlyMap<string, Buffer> | null {
    return this.storedEntries.get(name) ?? null;
  }
}

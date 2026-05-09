import type { McpRepoEntry, McpRepository, McpWriteOpts } from "./repository.js";

/** In-memory `McpRepository` for fast unit tests. */
export class InMemoryMcpRepository implements McpRepository {
  private readonly entries = new Map<string, string>();
  private readonly origins = new Map<string, string>();

  async read(name: string): Promise<string | null> {
    return this.entries.get(name) ?? null;
  }

  async write(name: string, content: string, opts: McpWriteOpts = {}): Promise<void> {
    this.entries.set(name, content);
    if (opts.origin !== undefined) this.origins.set(name, opts.origin);
  }

  async delete(name: string): Promise<void> {
    this.entries.delete(name);
    this.origins.delete(name);
  }

  async scan(): Promise<McpRepoEntry[]> {
    return [...this.entries].map(([name, content]) => {
      const origin = this.origins.get(name);
      const sourcePath = `memory:mcps/${name}.json`;
      return origin === undefined
        ? { name, content, sourcePath }
        : { name, content, sourcePath, origin };
    });
  }
}

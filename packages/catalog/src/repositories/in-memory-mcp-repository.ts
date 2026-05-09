import type { McpRepoEntry, McpRepository } from "./repository.js";

/** In-memory `McpRepository` for fast unit tests. */
export class InMemoryMcpRepository implements McpRepository {
  private readonly entries = new Map<string, string>();

  async read(name: string): Promise<string | null> {
    return this.entries.get(name) ?? null;
  }

  async write(name: string, content: string): Promise<void> {
    this.entries.set(name, content);
  }

  async delete(name: string): Promise<void> {
    this.entries.delete(name);
  }

  async scan(): Promise<McpRepoEntry[]> {
    return [...this.entries].map(([name, content]) => ({
      name,
      content,
      sourcePath: `memory:mcps/${name}.json`,
    }));
  }
}

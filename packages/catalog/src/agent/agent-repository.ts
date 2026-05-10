import type { Agent } from "./agent-entity.js";

/**
 * One file inside an agent, as yielded by {@link AgentRepository.streamFiles}.
 * `relPath` is POSIX-style; the anchor file is yielded under `"AGENTS.md"`.
 */
export interface AgentFile {
  readonly relPath: string;
  readonly content: Buffer;
}

/**
 * Persistence boundary for {@link Agent} domain entities.
 *
 * Mirrors {@link SkillRepository} — same atomic per-entry write
 * semantics, same `findByFqn` / `findByOrigin` / `findAll` /
 * `streamFiles` contract.
 */
export interface AgentRepository {
  add(agent: Agent, files: ReadonlyMap<string, Buffer>): Promise<void>;
  findByFqn(fqn: string): Promise<Agent | null>;
  findByOrigin(origin: string): Promise<Agent | null>;
  findAll(): Promise<Agent[]>;
  delete(fqn: string): Promise<void>;
  streamFiles(fqn: string): AsyncIterable<AgentFile>;
}

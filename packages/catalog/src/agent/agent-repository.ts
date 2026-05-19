import type { Agent, AgentDependencies } from "./agent-entity.js";

/**
 * One file inside an agent, as yielded by {@link AgentRepository.streamFiles}.
 * `relPath` is POSIX-style; the anchor file is yielded under `"AGENTS.md"`.
 */
export interface AgentFile {
  readonly relPath: string;
  readonly content: Buffer;
}

/**
 * Resolved fqn-form dependencies passed to {@link AgentRepository.add}.
 * The service layer resolves origin URIs to local fqns by looking up
 * sibling repositories, and hands the resulting lists to the repo so
 * it can populate the FK dep tables alongside the entity row.
 */
export interface AgentRepoAddDeps {
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
}

/**
 * Persistence boundary for {@link Agent} domain entities. v2 (issue
 * #122) splits the per-entity write into three concerns inside one
 * transaction: entity row, `agent_files` BLOB rows, dep table rows.
 */
export interface AgentRepository {
  /**
   * Persist `agent` together with its full file tree and resolved
   * dependencies. The anchor file (AGENTS.md) MUST be present in
   * `files` under `"AGENTS.md"`. `deps` is the fqn-form view —
   * unresolved origins are filtered out by the service.
   */
  add(agent: Agent, files: ReadonlyMap<string, Buffer>, deps: AgentRepoAddDeps): Promise<void>;
  findByFqn(fqn: string): Promise<Agent | null>;
  findByOrigin(origin: string): Promise<Agent | null>;
  findAll(): Promise<Agent[]>;
  delete(fqn: string): Promise<void>;
  streamFiles(fqn: string): AsyncIterable<AgentFile>;
  /**
   * Read the AGENTS.md bytes for `fqn`. Throws `AgentNotFoundError`
   * if no row exists. Catalog v2 explicit fetch API (was an inline
   * field on the entity in v1).
   */
  getAnchor(fqn: string): Promise<string>;
  /** Return the agent's fqn-form dep view as the repo sees it. */
  listDependencies(fqn: string): Promise<AgentDependencies>;
  /**
   * Update only the per-installation flags (`prereqsAck`,
   * `disabledByUser`) without touching frontmatter / files / anchor.
   * Each flag may be omitted to preserve its existing value. No-op if
   * the entry is absent.
   */
  setFlags(fqn: string, flags: { prereqsAck?: boolean; disabledByUser?: boolean }): Promise<void>;
  /**
   * Release any resources held by the repository (DB handles, file
   * locks). Optional: in-memory implementations have nothing to release.
   * Idempotent — implementations should tolerate being called twice.
   */
  close?(): void;
}

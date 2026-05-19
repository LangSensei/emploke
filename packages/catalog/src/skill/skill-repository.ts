import type { Skill, SkillDependencies } from "./skill-entity.js";

/**
 * One file inside a skill, as yielded by {@link SkillRepository.streamFiles}.
 */
export interface SkillFile {
  readonly relPath: string;
  readonly content: Buffer;
}

/**
 * Resolved fqn-form dependencies passed to {@link SkillRepository.add}.
 * See {@link AgentRepoAddDeps}.
 */
export interface SkillRepoAddDeps {
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
}

export interface SkillRepository {
  /**
   * Persist `skill` together with its full file tree and resolved
   * dependencies. The anchor file (SKILL.md) MUST be present in
   * `files` under `"SKILL.md"`. `deps` is the fqn-form view.
   */
  add(skill: Skill, files: ReadonlyMap<string, Buffer>, deps: SkillRepoAddDeps): Promise<void>;
  findByFqn(fqn: string): Promise<Skill | null>;
  findByOrigin(origin: string): Promise<Skill | null>;
  findAll(): Promise<Skill[]>;
  delete(fqn: string): Promise<void>;
  streamFiles(fqn: string): AsyncIterable<SkillFile>;
  /**
   * Read the SKILL.md bytes for `fqn`. Throws `SkillNotFoundError`
   * if no row exists.
   */
  getAnchor(fqn: string): Promise<string>;
  listDependencies(fqn: string): Promise<SkillDependencies>;
  /**
   * Indexed reverse-dep lookup: agents that list `targetFqn` in
   * their `agent_skill_dependencies`.
   */
  findDependentAgents(targetFqn: string): Promise<string[]>;
  /**
   * Indexed reverse-dep lookup: skills that list `targetFqn` in
   * their `skill_skill_dependencies`.
   */
  findDependentSkills(targetFqn: string): Promise<string[]>;
  setFlags(fqn: string, flags: { prereqsAck?: boolean }): Promise<void>;
  close?(): void;
}

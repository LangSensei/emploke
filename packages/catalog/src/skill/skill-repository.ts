import type { Skill } from "./skill-entity.js";

/**
 * One file inside a skill, as yielded by {@link SkillRepository.streamFiles}.
 *
 * `relPath` is POSIX-style (`/` separator) regardless of host OS, so
 * consumers can string-concatenate without re-normalising. The anchor
 * file (SKILL.md) is yielded under `"SKILL.md"`.
 */
export interface SkillFile {
  readonly relPath: string;
  readonly content: Buffer;
}

/**
 * Persistence boundary for {@link Skill} domain entities.
 *
 * The repository is the only collaborator allowed to construct entities
 * via `Skill.fromStored` (the reconstitution factory). Other layers go
 * through `Skill.create` for new entities.
 *
 * Skills are multi-file: each entity has an anchor (SKILL.md) plus
 * arbitrary sibling files. The repository persists the entity's
 * metadata and the file tree as a single atomic unit (a failed `add`
 * MUST NOT leave a partial entry visible).
 *
 * Responsibilities:
 *   - persist entity metadata + full file tree atomically per entry
 *   - reconstitute entities from storage
 *   - stream files back on demand
 *   - secondary lookup by origin (for resolve's already-installed skip)
 *
 * NON-responsibilities:
 *   - parsing / validating entity content (entity factories do that)
 *   - enforcing business invariants like origin-conflict (caller's job)
 *   - serializing concurrent writers (caller wraps in a queue, OR the
 *     backend's own concurrency model handles it — SQLite does)
 */
export interface SkillRepository {
  /**
   * Persist `skill` together with its full file tree. The anchor file
   * (SKILL.md) MUST be present in `files` under `"SKILL.md"`.
   *
   * Overwrites any existing entry with the same name (full replacement
   * — old sibling files not in `files` are removed). Origin-conflict
   * detection is the caller's responsibility.
   *
   * MUST be atomic: a failed `add` MUST NOT leave a partial entry
   * visible to subsequent reads.
   */
  add(skill: Skill, files: ReadonlyMap<string, Buffer>): Promise<void>;

  /** Reconstitute the entity for `name`, or `null` if no entry exists. */
  findByFqn(fqn: string): Promise<Skill | null>;

  /**
   * Reconstitute the entity for the given origin URI, or `null` if no
   * entry's origin matches. Used by resolve's already-installed skip.
   * Implementations SHOULD index `origin` for efficiency.
   */
  findByOrigin(origin: string): Promise<Skill | null>;

  /** Reconstitute every stored entity. */
  findAll(): Promise<Skill[]>;

  /** Remove the entry for `name` (cascades to all sibling files). No-op if absent. */
  delete(fqn: string): Promise<void>;

  /**
   * Stream every file (anchor + siblings) belonging to `name`. Throws
   * if the skill doesn't exist. Order is unspecified; consumers must
   * not depend on it.
   */
  streamFiles(fqn: string): AsyncIterable<SkillFile>;
}

import type { Mcp } from "./mcp-entity.js";

/**
 * Persistence boundary for {@link Mcp} domain entities.
 *
 * The repository is the only collaborator allowed to construct entities
 * via `Mcp.fromStored` (the reconstitution factory). Other layers go
 * through `Mcp.create` for new entities or call repository methods to
 * obtain existing ones — they should never see raw `(name, origin,
 * content)` tuples.
 *
 * Responsibilities:
 *   - persist entity state under the entity's identity key
 *     (`mcp.name`), atomically per entry
 *   - reconstitute entities from storage on read / scan
 *   - reject identity keys that can't be safely mapped to a storage
 *     key (path-safety, character escapes, etc — implementation-specific)
 *
 * NON-responsibilities:
 *   - parsing / validating the entity's content (the entity's own
 *     factories do that)
 *   - enforcing business invariants like origin-conflict (caller's job
 *     via read-then-decide)
 *   - serializing concurrent writers (caller wraps in its own queue)
 */
export interface McpRepository {
  /**
   * Persist `mcp`. Overwrites any existing entry with the same name
   * without comparison — origin-conflict detection is the caller's
   * responsibility (they hold the in-memory index).
   *
   * MUST be atomic per entry: a failed `add` MUST NOT leave a partial
   * entry visible to subsequent reads.
   */
  add(mcp: Mcp): Promise<void>;

  /** Reconstitute the entity for `name`, or `null` if no entry exists. */
  findByName(name: string): Promise<Mcp | null>;

  /**
   * Reconstitute the entity for the given origin URI, or `null` if no
   * entry's origin matches. Used by the cross-entity facade's
   * already-installed skip when walking dep refs (which are bare
   * origin strings).
   */
  findByOrigin(origin: string): Promise<Mcp | null>;

  /** Remove the entry for `name`. No-op if absent. */
  delete(name: string): Promise<void>;

  /**
   * Reconstitute every stored entity. Used by the service layer to
   * implement `list` and (re)build any in-memory views the caller
   * might want to maintain.
   */
  findAll(): Promise<Mcp[]>;
}

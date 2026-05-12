import * as SkillFormat from "./skill-frontmatter.js";
import { makeFqn, validateFqn } from "./validate.js";

/**
 * Rich domain entity representing a single installed skill.
 *
 * Identity = (fqn, origin), both immutable.
 *
 * - `fqn` (`<scope>/<shortName>`) is the catalog identity — the local
 *   namespace key used for storage and dep lookups.
 * - `origin` is the install-source URI — the global identity, used for
 *   deduplication and conflict detection.
 *
 * `fqn` exists because skills carry a kebab-case `name:` in their
 *  frontmatter that's NOT globally unique on its own (two authors can
 *  pick "tool-use"); emploke adds a `scope:` segment to disambiguate
 *  in the local catalog.
 *
 * The skill's anchor file (SKILL.md content) is replaceable via
 * {@link withAnchor}, which returns a new entity preserving identity.
 *
 * Construction goes through factories, never the constructor directly:
 *   - {@link Skill.create} — for fresh installs from raw user bytes.
 *   - {@link Skill.fromStored} — for reconstitution by the repository.
 *
 * Files: this entity does NOT hold the skill's file tree (siblings of
 * SKILL.md). The repository exposes `streamFiles(fqn)` for that.
 *
 * Per-installation flag (NOT in frontmatter — local opt-in):
 *   - `prereqsAck`: user has acknowledged the entry's `prereqs` text
 *     (or the entry has none). Default at fresh install is computed
 *     from `meta.prereqs`: empty / undefined → `true`, else `false`.
 *
 * Note: orphan-status (zero reverse-deps) is NOT a property of the
 * entity — it's a derived fact over the full catalog dep graph. The
 * facade computes it lazily at projection time via the cascade context.
 *
 * **Authoring contract — `version` is the source of truth for change.**
 * Sync from upstream and the resolve-vs-install staleness check both
 * key off `version` alone: any meaningful edit to SKILL.md (frontmatter
 * or body) MUST be paired with a `version` bump. Edits without a bump
 * are treated as no-ops by emploke and will not propagate to installed
 * catalogs. We do not byte-hash the file because (a) the grammar of
 * "what counts as a meaningful change" is the author's call, not
 * emploke's, and (b) hashing would surface noise (line endings,
 * trailing whitespace, key reordering) as spurious diffs.
 */
export class Skill {
  private constructor(
    private readonly _fqn: string,
    private readonly _origin: string,
    private readonly _scope: string,
    private readonly _shortName: string,
    private readonly _description: string,
    private readonly _version: string,
    private readonly _prereqs: string | undefined,
    private readonly _dependencies: SkillDependencies,
    private readonly _anchorContent: string,
    private readonly _prereqsAck: boolean,
  ) {}

  static create(rawSkillMd: string, origin: string, sourceLabel: string): Skill {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("Skill.create requires a non-empty origin string");
    }
    const { meta } = SkillFormat.parse(rawSkillMd, sourceLabel);
    const fqn = makeFqn(meta.scope, meta.shortName);
    const prereqsAck = !hasNonEmptyPrereqs(meta.prereqs);
    return new Skill(
      fqn,
      origin,
      meta.scope,
      meta.shortName,
      meta.description,
      meta.version,
      meta.prereqs,
      normaliseDeps(meta.dependencies),
      rawSkillMd,
      prereqsAck,
    );
  }

  /**
   * Reconstitute an entity from previously-persisted state. INTENDED
   * FOR USE BY `SkillRepository` IMPLEMENTATIONS ONLY.
   */
  static fromStored(args: {
    fqn: string;
    origin: string;
    scope: string;
    shortName: string;
    description: string;
    version: string;
    prereqs: string | undefined;
    dependencies: SkillDependencies;
    anchorContent: string;
    prereqsAck: boolean;
  }): Skill {
    validateFqn(args.fqn);
    return new Skill(
      args.fqn,
      args.origin,
      args.scope,
      args.shortName,
      args.description,
      args.version,
      args.prereqs,
      normaliseDeps(args.dependencies),
      args.anchorContent,
      args.prereqsAck,
    );
  }

  get fqn(): string {
    return this._fqn;
  }
  get origin(): string {
    return this._origin;
  }
  get scope(): string {
    return this._scope;
  }
  get shortName(): string {
    return this._shortName;
  }
  get description(): string {
    return this._description;
  }
  get version(): string {
    return this._version;
  }
  get prereqs(): string | undefined {
    return this._prereqs;
  }
  get dependencies(): SkillDependencies {
    return this._dependencies;
  }
  /** Raw bytes of SKILL.md (frontmatter + body). */
  get anchorContent(): string {
    return this._anchorContent;
  }
  get prereqsAck(): boolean {
    return this._prereqsAck;
  }

  /**
   * Plain JSON projection of the entity. JSON.stringify() picks this
   * up automatically — the rich getters live on the prototype and
   * wouldn't otherwise serialise.
   *
   * `orphaned` is intentionally NOT projected here; it's a derived
   * fact over the full catalog dep graph and is added by the facade's
   * pojo projection helpers, not by the entity in isolation.
   */
  toJSON(): Record<string, unknown> {
    return {
      fqn: this._fqn,
      shortName: this._shortName,
      scope: this._scope,
      origin: this._origin,
      description: this._description,
      version: this._version,
      prereqsAck: this._prereqsAck,
      ...(this._prereqs !== undefined ? { prereqs: this._prereqs } : {}),
      ...(this._dependencies.skills.length > 0 || this._dependencies.mcps.length > 0
        ? {
            dependencies: {
              ...(this._dependencies.skills.length > 0
                ? { skills: this._dependencies.skills }
                : {}),
              ...(this._dependencies.mcps.length > 0 ? { mcps: this._dependencies.mcps } : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Return a new entity with replaced anchor content. Identity (fqn,
   * origin) is preserved by validating that the new frontmatter still
   * yields the same FQN. If the new frontmatter declares a different
   * scope or shortName, throws — callers must delete + reinstall to
   * change identity.
   *
   * Per-installation flag `prereqsAck` is preserved.
   */
  withAnchor(rawSkillMd: string, sourceLabel: string): Skill {
    const { meta } = SkillFormat.parse(rawSkillMd, sourceLabel);
    const newFqn = makeFqn(meta.scope, meta.shortName);
    if (newFqn !== this._fqn) {
      throw new TypeError(
        `Skill.withAnchor cannot change identity: existing "${this._fqn}" vs new "${newFqn}". ` +
          "Delete and reinstall to rename.",
      );
    }
    return new Skill(
      this._fqn,
      this._origin,
      meta.scope,
      meta.shortName,
      meta.description,
      meta.version,
      meta.prereqs,
      normaliseDeps(meta.dependencies),
      rawSkillMd,
      this._prereqsAck,
    );
  }

  /**
   * Return a new entity with one or more per-installation flags
   * replaced. Identity and frontmatter are preserved.
   */
  withState(state: { prereqsAck?: boolean }): Skill {
    return new Skill(
      this._fqn,
      this._origin,
      this._scope,
      this._shortName,
      this._description,
      this._version,
      this._prereqs,
      this._dependencies,
      this._anchorContent,
      state.prereqsAck ?? this._prereqsAck,
    );
  }
}

/**
 * A dependency reference: just an origin URI. The dep target's true
 * identity (fqn) is computed at resolve time by fetching the anchor.
 *
 * String alias rather than `{ origin: string }` object — keeps the
 * frontmatter wire shape compact.
 */
export type SkillDependencyRef = string;

export interface SkillDependencies {
  readonly skills: readonly SkillDependencyRef[];
  readonly mcps: readonly SkillDependencyRef[];
}

function normaliseDeps(
  deps:
    | { skills?: readonly SkillDependencyRef[]; mcps?: readonly SkillDependencyRef[] }
    | undefined,
): SkillDependencies {
  return {
    skills: deps?.skills ?? [],
    mcps: deps?.mcps ?? [],
  };
}

/** True iff `prereqs` is a non-empty, non-whitespace-only string. */
export function hasNonEmptyPrereqs(prereqs: string | undefined): boolean {
  return prereqs !== undefined && prereqs.trim().length > 0;
}

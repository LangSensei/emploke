import * as SkillFormat from "./skill-frontmatter.js";
import { makeFqn, splitFqn, validateFqn } from "./validate.js";

/**
 * Rich domain entity representing a single installed skill.
 *
 * Identity = (fqn, origin), both immutable. Schema v2 (issue #122):
 *   - `scope` / `shortName` are derived getters off `fqn.split('/')`.
 *   - Anchor bytes (SKILL.md) are no longer held on the entity; the
 *     repository's `getAnchor(fqn)` is the canonical fetch path.
 *   - `installedAt` / `updatedAt` ISO 8601 UTC timestamps surface on
 *     the entity so DTO projections can include them.
 *   - `dependencies` is the fqn-form view (populated by `fromStored`
 *     from the dep-tables join); `depsRefs` carries the frontmatter
 *     origins for the install pipeline's lookup.
 */
export class Skill {
  private constructor(
    private readonly _fqn: string,
    private readonly _origin: string,
    private readonly _description: string,
    private readonly _version: string,
    private readonly _prereqs: string | undefined,
    private readonly _dependencies: SkillDependencies,
    private readonly _depsRefs: SkillDepRefs,
    private readonly _prereqsAck: boolean,
    private readonly _installedAt: string,
    private readonly _updatedAt: string,
  ) {}

  static create(rawSkillMd: string, origin: string, sourceLabel: string): Skill {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("Skill.create requires a non-empty origin string");
    }
    const { meta } = SkillFormat.parse(rawSkillMd, sourceLabel);
    const fqn = makeFqn(meta.scope, meta.shortName);
    const prereqsAck = !hasNonEmptyPrereqs(meta.prereqs);
    const now = new Date().toISOString();
    return new Skill(
      fqn,
      origin,
      meta.description,
      meta.version,
      meta.prereqs,
      { skills: [], mcps: [] },
      normaliseDepRefs(meta.dependencies),
      prereqsAck,
      now,
      now,
    );
  }

  static fromStored(args: {
    fqn: string;
    origin: string;
    description: string;
    version: string;
    prereqs: string | undefined;
    dependencies: SkillDependencies;
    prereqsAck: boolean;
    installedAt: string;
    updatedAt: string;
  }): Skill {
    validateFqn(args.fqn);
    return new Skill(
      args.fqn,
      args.origin,
      args.description,
      args.version,
      args.prereqs,
      normaliseDeps(args.dependencies),
      { skills: [], mcps: [] },
      args.prereqsAck,
      args.installedAt,
      args.updatedAt,
    );
  }

  get fqn(): string {
    return this._fqn;
  }
  get origin(): string {
    return this._origin;
  }
  /** Derived from `fqn` — first segment. */
  get scope(): string {
    return splitFqn(this._fqn).scope;
  }
  /** Derived from `fqn` — second segment. */
  get shortName(): string {
    return splitFqn(this._fqn).shortName;
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
  /** See {@link Agent.dependencies}. */
  get dependencies(): SkillDependencies {
    return this._dependencies;
  }
  /** See {@link Agent.depsRefs}. */
  get depsRefs(): SkillDepRefs {
    return this._depsRefs;
  }
  get prereqsAck(): boolean {
    return this._prereqsAck;
  }
  get installedAt(): string {
    return this._installedAt;
  }
  get updatedAt(): string {
    return this._updatedAt;
  }

  toJSON(): Record<string, unknown> {
    return {
      fqn: this._fqn,
      origin: this._origin,
      description: this._description,
      version: this._version,
      prereqsAck: this._prereqsAck,
      installedAt: this._installedAt,
      updatedAt: this._updatedAt,
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
      meta.description,
      meta.version,
      meta.prereqs,
      this._dependencies,
      normaliseDepRefs(meta.dependencies),
      this._prereqsAck,
      this._installedAt,
      new Date().toISOString(),
    );
  }

  withState(state: { prereqsAck?: boolean }): Skill {
    return new Skill(
      this._fqn,
      this._origin,
      this._description,
      this._version,
      this._prereqs,
      this._dependencies,
      this._depsRefs,
      state.prereqsAck ?? this._prereqsAck,
      this._installedAt,
      this._updatedAt,
    );
  }

  withDependencies(deps: SkillDependencies): Skill {
    return new Skill(
      this._fqn,
      this._origin,
      this._description,
      this._version,
      this._prereqs,
      normaliseDeps(deps),
      this._depsRefs,
      this._prereqsAck,
      this._installedAt,
      this._updatedAt,
    );
  }
}

export interface SkillDependencyRef {
  readonly fqn: string;
}

export interface SkillDependencies {
  readonly skills: readonly SkillDependencyRef[];
  readonly mcps: readonly SkillDependencyRef[];
}

export interface SkillDepRefs {
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
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

function normaliseDepRefs(
  deps: { skills?: readonly string[]; mcps?: readonly string[] } | undefined,
): SkillDepRefs {
  return {
    skills: deps?.skills ?? [],
    mcps: deps?.mcps ?? [],
  };
}

/** True iff `prereqs` is a non-empty, non-whitespace-only string. */
export function hasNonEmptyPrereqs(prereqs: string | undefined): boolean {
  return prereqs !== undefined && prereqs.trim().length > 0;
}

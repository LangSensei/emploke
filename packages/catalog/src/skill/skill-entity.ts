import {
  type AnchoredEntityState,
  type AnchoredStateBuilderConfig,
  applyAnchorPatch,
  buildInitialAnchoredState,
  buildStoredAnchoredState,
} from "../_shared/anchored-state.js";
import {
  type DependencyRef,
  depsToJSON,
  type FqnDeps,
  normaliseFqnDeps,
  type OriginDeps,
} from "../_shared/dep-keys.js";
import { hasNonEmptyPrereqs } from "../_shared/entity-helpers.js";
import {
  parse,
  SKILL_DEP_SPECS,
  type SkillDepKind,
  writeFrontmatter,
} from "./skill-frontmatter.js";
import { makeFqn, splitFqn, validateFqn } from "./validate.js";

/**
 * Rich domain entity representing a single installed skill.
 *
 * Identity = `fqn`; `origin` is provenance, not identity.
 *   - `scope` / `shortName` are derived getters off `fqn.split('/')`.
 *   - Anchor bytes (SKILL.md) are NOT held on the entity; the
 *     repository's `getAnchor(fqn)` is the canonical fetch path.
 *   - `installedAt` / `updatedAt` ISO 8601 UTC timestamps surface on
 *     the entity so DTO projections can include them.
 *   - `dependencies` is the fqn-form view (populated by `fromStored`
 *     from the dep-tables join); `depsRefs` carries the frontmatter
 *     origins for the install pipeline's lookup.
 *
 * Composition: this class wraps an `AnchoredEntityState<SkillDepKind>`
 * built by the `_shared/anchored-state.ts` helpers. No inheritance —
 * skills carry no kind-specific extras (`disabledByUser` is agent-
 * only), so the class has fewer fields than `AgentEntity`.
 */

const SKILL_CONFIG: AnchoredStateBuilderConfig<SkillDepKind> = {
  label: "SkillEntity",
  depSpecs: SKILL_DEP_SPECS,
  codec: { parse, writeFrontmatter },
  validators: { makeFqn, splitFqn, validateFqn },
};

/** A resolved fqn-form dep reference. */
export type SkillDependencyRef = DependencyRef;

export type SkillDependencies = FqnDeps<SkillDepKind>;
export type SkillDepRefs = OriginDeps<SkillDepKind>;

export class SkillEntity {
  private constructor(private readonly _state: AnchoredEntityState<SkillDepKind>) {}

  static create(rawSkillMd: string, origin: string, sourceLabel: string): SkillEntity {
    const state = buildInitialAnchoredState(rawSkillMd, origin, sourceLabel, SKILL_CONFIG);
    return new SkillEntity(state);
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
  }): SkillEntity {
    const state = buildStoredAnchoredState<SkillDepKind>(args, SKILL_CONFIG);
    return new SkillEntity(state);
  }

  /** Canonical FQN — the entity's identity. */
  get id(): string {
    return this._state.fqn;
  }
  get fqn(): string {
    return this._state.fqn;
  }
  get origin(): string {
    return this._state.origin;
  }
  /** Derived from `fqn` — first segment. */
  get scope(): string {
    return splitFqn(this._state.fqn).scope;
  }
  /** Derived from `fqn` — second segment. */
  get shortName(): string {
    return splitFqn(this._state.fqn).shortName;
  }
  get description(): string {
    return this._state.description;
  }
  get version(): string {
    return this._state.version;
  }
  get prereqs(): string | undefined {
    return this._state.prereqs;
  }
  /** See {@link AgentEntity.dependencies}. */
  get dependencies(): SkillDependencies {
    return this._state.dependencies;
  }
  /** See {@link AgentEntity.depsRefs}. */
  get depsRefs(): SkillDepRefs {
    return this._state.depsRefs;
  }
  get prereqsAck(): boolean {
    return this._state.prereqsAck;
  }
  get installedAt(): string {
    return this._state.installedAt;
  }
  get updatedAt(): string {
    return this._state.updatedAt;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      fqn: this._state.fqn,
      origin: this._state.origin,
      description: this._state.description,
      version: this._state.version,
      prereqsAck: this._state.prereqsAck,
      installedAt: this._state.installedAt,
      updatedAt: this._state.updatedAt,
    };
    if (this._state.prereqs !== undefined) out.prereqs = this._state.prereqs;
    const depsJson = depsToJSON(SKILL_DEP_SPECS, this._state.dependencies);
    if (depsJson !== undefined) out.dependencies = depsJson;
    return out;
  }

  withAnchor(rawSkillMd: string, sourceLabel: string): SkillEntity {
    return new SkillEntity(applyAnchorPatch(this._state, rawSkillMd, sourceLabel, SKILL_CONFIG));
  }

  withState(state: { prereqsAck?: boolean }): SkillEntity {
    return new SkillEntity({
      ...this._state,
      prereqsAck: state.prereqsAck ?? this._state.prereqsAck,
    });
  }

  withDependencies(deps: SkillDependencies): SkillEntity {
    return new SkillEntity({
      ...this._state,
      dependencies: normaliseFqnDeps(SKILL_DEP_SPECS, deps),
    });
  }
}

// Compat re-exports preserved as named exports off this module so
// callers (catalog index.ts, skill index.ts) keep their import shape.
export { hasNonEmptyPrereqs };

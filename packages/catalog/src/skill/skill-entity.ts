import {
  type DependencyRef,
  depsToJSON,
  emptyDeps,
  emptyOriginDeps,
  type FqnDeps,
  normaliseFqnDeps,
  type OriginDeps,
} from "../_shared/dep-keys.js";
import {
  hasNonEmptyPrereqs,
  initialPrereqsAck,
  nowIso,
  requireNonEmptyOrigin,
} from "../_shared/entity-helpers.js";
import { metaDepsToOriginDeps } from "../_shared/frontmatter-codec.js";
import { parse, SKILL_DEP_SPECS, type SkillDepKind } from "./skill-frontmatter.js";
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
 * Skill owns its `SkillEntityState` interface + state builders inline
 * below. There is intentionally no shared per-installation-state
 * abstraction — agent and skill are independent kinds that happen to
 * look structurally similar today, and a shared abstraction forces
 * coordinated changes the moment they diverge on any field. Agent
 * mirrors the same shape in its own file by intent; duplication beats
 * domain coupling. Skill carries no kind-specific extras
 * (`disabledByUser` is agent-only), so the class has fewer fields
 * than `AgentEntity`.
 */

/** Per-installation state for a single skill. */
interface SkillEntityState {
  readonly fqn: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs: string | undefined;
  readonly dependencies: FqnDeps<SkillDepKind>;
  readonly depsRefs: OriginDeps<SkillDepKind>;
  readonly prereqsAck: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

/** Build the initial state from raw SKILL.md bytes. Used by `SkillEntity.create`. */
function buildInitialSkillState(
  raw: string,
  origin: string,
  sourceLabel: string,
): SkillEntityState {
  requireNonEmptyOrigin(origin, "SkillEntity.create");
  const { meta } = parse(raw, sourceLabel);
  const fqn = makeFqn(meta.scope, meta.shortName);
  const now = nowIso();
  return {
    fqn,
    origin,
    description: meta.description,
    version: meta.version,
    prereqs: meta.prereqs,
    dependencies: emptyDeps(SKILL_DEP_SPECS),
    depsRefs: metaDepsToOriginDeps(SKILL_DEP_SPECS, meta),
    prereqsAck: initialPrereqsAck(meta.prereqs),
    installedAt: now,
    updatedAt: now,
  };
}

/**
 * Build state from a stored row. `depsRefs` defaults to empty (origins
 * aren't persisted past install — only the resolved fqns are).
 */
function buildStoredSkillState(args: {
  readonly fqn: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs: string | undefined;
  readonly dependencies: FqnDeps<SkillDepKind>;
  readonly prereqsAck: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly depsRefs?: OriginDeps<SkillDepKind>;
}): SkillEntityState {
  validateFqn(args.fqn);
  return {
    fqn: args.fqn,
    origin: args.origin,
    description: args.description,
    version: args.version,
    prereqs: args.prereqs,
    dependencies: normaliseFqnDeps(SKILL_DEP_SPECS, args.dependencies),
    depsRefs: args.depsRefs ?? emptyOriginDeps(SKILL_DEP_SPECS),
    prereqsAck: args.prereqsAck,
    installedAt: args.installedAt,
    updatedAt: args.updatedAt,
  };
}

/**
 * Apply a new anchor's bytes to existing state. Identity (`fqn`) MUST
 * NOT change — throws `TypeError` otherwise (caller must delete and
 * reinstall to rename). Body bytes are NOT held on the state; the
 * repository's `getAnchor(fqn)` is the canonical fetch path.
 */
function applySkillAnchorPatch(
  state: SkillEntityState,
  raw: string,
  sourceLabel: string,
): SkillEntityState {
  const { meta } = parse(raw, sourceLabel);
  const newFqn = makeFqn(meta.scope, meta.shortName);
  if (newFqn !== state.fqn) {
    throw new TypeError(
      `SkillEntity.withAnchor cannot change identity: ` +
        `existing "${state.fqn}" vs new "${newFqn}". ` +
        "Delete and reinstall to rename.",
    );
  }
  return {
    ...state,
    description: meta.description,
    version: meta.version,
    prereqs: meta.prereqs,
    depsRefs: metaDepsToOriginDeps(SKILL_DEP_SPECS, meta),
    updatedAt: nowIso(),
  };
}

/** A resolved fqn-form dep reference. */
export type SkillDependencyRef = DependencyRef;

export type SkillDependencies = FqnDeps<SkillDepKind>;
export type SkillDepRefs = OriginDeps<SkillDepKind>;

export class SkillEntity {
  private constructor(private readonly _state: SkillEntityState) {}

  static create(rawSkillMd: string, origin: string, sourceLabel: string): SkillEntity {
    return new SkillEntity(buildInitialSkillState(rawSkillMd, origin, sourceLabel));
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
    return new SkillEntity(buildStoredSkillState(args));
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
    return new SkillEntity(applySkillAnchorPatch(this._state, rawSkillMd, sourceLabel));
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

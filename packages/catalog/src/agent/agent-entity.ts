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
  AGENT_DEP_SPECS,
  type AgentDepKind,
  parse,
  writeFrontmatter,
} from "./agent-frontmatter.js";
import { makeFqn, splitFqn, validateFqn } from "./validate.js";

/**
 * Rich domain entity representing a single installed agent.
 *
 * Identity = `fqn`; `origin` is provenance, not identity.
 *   - `scope` / `shortName` are derived getters off `fqn.split('/')`.
 *   - Anchor bytes (AGENTS.md) are NOT held on the entity; the
 *     repository's `getAnchor(fqn)` is the canonical fetch path.
 *   - `installedAt` / `updatedAt` ISO 8601 UTC timestamps surface on
 *     the entity so DTO projections can include them.
 *   - `dependencies` is the fqn-form view (populated by `fromStored`
 *     from the dep-tables join); freshly-created entities have empty
 *     `dependencies` because the install pipeline hasn't resolved
 *     origins to fqns yet. The frontmatter-declared origins live on
 *     {@link depsRefs} and drive that resolution.
 *
 * Composition: this class wraps an `AnchoredEntityState<AgentDepKind>`
 * built by the `_shared/anchored-state.ts` helpers, plus an agent-only
 * `_disabledByUser` flag. No inheritance — the `Skill` DTO MUST NOT
 * grow `disabledByUser` so skill carries its own (smaller) state
 * wrapper that doesn't know about this flag.
 */

const AGENT_CONFIG: AnchoredStateBuilderConfig<AgentDepKind> = {
  label: "AgentEntity",
  depSpecs: AGENT_DEP_SPECS,
  codec: { parse, writeFrontmatter },
  validators: { makeFqn, splitFqn, validateFqn },
};

/** A resolved fqn-form dep reference. */
export type AgentDependencyRef = DependencyRef;

/** Resolved fqn-form deps view (catalog-side projection). */
export type AgentDependencies = FqnDeps<AgentDepKind>;

/** Frontmatter-declared dep origins (install-pipeline side). */
export type AgentDepRefs = OriginDeps<AgentDepKind>;

export class AgentEntity {
  private constructor(
    private readonly _state: AnchoredEntityState<AgentDepKind>,
    private readonly _disabledByUser: boolean,
  ) {}

  static create(rawAgentMd: string, origin: string, sourceLabel: string): AgentEntity {
    const state = buildInitialAnchoredState(rawAgentMd, origin, sourceLabel, AGENT_CONFIG);
    return new AgentEntity(state, false);
  }

  static fromStored(args: {
    fqn: string;
    origin: string;
    description: string;
    version: string;
    prereqs: string | undefined;
    dependencies: AgentDependencies;
    prereqsAck: boolean;
    disabledByUser: boolean;
    installedAt: string;
    updatedAt: string;
  }): AgentEntity {
    const state = buildStoredAnchoredState<AgentDepKind>(
      {
        fqn: args.fqn,
        origin: args.origin,
        description: args.description,
        version: args.version,
        prereqs: args.prereqs,
        dependencies: args.dependencies,
        prereqsAck: args.prereqsAck,
        installedAt: args.installedAt,
        updatedAt: args.updatedAt,
      },
      AGENT_CONFIG,
    );
    return new AgentEntity(state, args.disabledByUser);
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
  /**
   * Local-catalog dependency view: each entry is an fqn of an installed
   * sibling. Populated by `fromStored` (repository reads the dep tables);
   * freshly created entities expose empty arrays until the install
   * pipeline writes the dep rows.
   */
  get dependencies(): AgentDependencies {
    return this._state.dependencies;
  }
  /**
   * Origin URIs declared in the frontmatter `dependencies` block.
   * Used by the install pipeline to look up sibling fqns. Empty for
   * entities loaded via `fromStored` (origins aren't persisted past
   * install — only the resolved fqns are).
   */
  get depsRefs(): AgentDepRefs {
    return this._state.depsRefs;
  }
  get prereqsAck(): boolean {
    return this._state.prereqsAck;
  }
  /** True iff the user has explicitly disabled this agent. Skills cannot be user-disabled. */
  get disabledByUser(): boolean {
    return this._disabledByUser;
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
      disabledByUser: this._disabledByUser,
      installedAt: this._state.installedAt,
      updatedAt: this._state.updatedAt,
    };
    if (this._state.prereqs !== undefined) out.prereqs = this._state.prereqs;
    const depsJson = depsToJSON(AGENT_DEP_SPECS, this._state.dependencies);
    if (depsJson !== undefined) out.dependencies = depsJson;
    return out;
  }

  /**
   * Refresh frontmatter fields from a new anchor bytes (identity
   * unchanged); bumps `updatedAt`. The new anchor bytes themselves
   * are written by the repository (single source of truth in
   * `agent_files`); this method merely projects the updated metadata
   * and dep refs back onto the entity.
   */
  withAnchor(rawAgentMd: string, sourceLabel: string): AgentEntity {
    return new AgentEntity(
      applyAnchorPatch(this._state, rawAgentMd, sourceLabel, AGENT_CONFIG),
      this._disabledByUser,
    );
  }

  /**
   * Return a new entity with one or more per-installation flags
   * replaced. Identity and frontmatter are preserved.
   */
  withState(state: { prereqsAck?: boolean; disabledByUser?: boolean }): AgentEntity {
    return new AgentEntity(
      { ...this._state, prereqsAck: state.prereqsAck ?? this._state.prereqsAck },
      state.disabledByUser ?? this._disabledByUser,
    );
  }

  /** Return a new entity carrying the given resolved fqn dependencies. */
  withDependencies(deps: AgentDependencies): AgentEntity {
    return new AgentEntity(
      { ...this._state, dependencies: normaliseFqnDeps(AGENT_DEP_SPECS, deps) },
      this._disabledByUser,
    );
  }
}

// Compat re-exports preserved as named exports off this module so
// callers (catalog index.ts, agent index.ts) keep their import shape.
export { hasNonEmptyPrereqs };

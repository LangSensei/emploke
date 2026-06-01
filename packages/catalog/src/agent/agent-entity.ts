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
  AGENT_DEP_SPECS,
  type AgentDepKind,
  type AgentFrontmatter,
  parse,
} from "./agent-frontmatter.js";
import { makeFqn, splitFqn, validateFqn } from "./validate.js";

/**
 * File-private: pull `meta.dependencies` into a dense
 * `OriginDeps<AgentDepKind>` with every dep-kind present (empty array
 * when absent). Per-kind inline — the only shared module across kinds
 * is `_shared/dep-keys.ts`, which is parametric and names no
 * agent-specific concept.
 */
function depsAsOrigins(meta: AgentFrontmatter): OriginDeps<AgentDepKind> {
  const out = {} as Record<AgentDepKind, readonly string[]>;
  for (const s of AGENT_DEP_SPECS) {
    out[s.kind] = meta.dependencies?.[s.kind] ?? [];
  }
  return out;
}

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
 * Agent owns its `AgentEntityState` interface + state builders inline
 * below, plus an agent-only `_disabledByUser` flag. There is
 * intentionally no shared per-installation-state abstraction — agent
 * and skill are independent kinds that happen to look structurally
 * similar today, and a shared abstraction forces coordinated changes
 * the moment they diverge on any field. Skill mirrors the same shape
 * in its own file by intent; duplication beats domain coupling.
 */

/** Per-installation state for a single agent. */
interface AgentEntityState {
  readonly fqn: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs: string | undefined;
  readonly dependencies: FqnDeps<AgentDepKind>;
  readonly depsRefs: OriginDeps<AgentDepKind>;
  readonly prereqsAck: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

/** Build the initial state from raw AGENTS.md bytes. Used by `AgentEntity.create`. */
function buildInitialAgentState(
  raw: string,
  origin: string,
  sourceLabel: string,
): AgentEntityState {
  if (typeof origin !== "string" || origin.length === 0) {
    throw new TypeError("AgentEntity.create requires a non-empty origin string");
  }
  const { meta } = parse(raw, sourceLabel);
  const fqn = makeFqn(meta.scope, meta.shortName);
  const now = new Date().toISOString();
  return {
    fqn,
    origin,
    description: meta.description,
    version: meta.version,
    prereqs: meta.prereqs,
    dependencies: emptyDeps(AGENT_DEP_SPECS),
    depsRefs: depsAsOrigins(meta),
    prereqsAck: (meta.prereqs ?? "").trim().length === 0,
    installedAt: now,
    updatedAt: now,
  };
}

/**
 * Build state from a stored row. `depsRefs` defaults to empty (origins
 * aren't persisted past install — only the resolved fqns are).
 */
function buildStoredAgentState(args: {
  readonly fqn: string;
  readonly origin: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs: string | undefined;
  readonly dependencies: FqnDeps<AgentDepKind>;
  readonly prereqsAck: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly depsRefs?: OriginDeps<AgentDepKind>;
}): AgentEntityState {
  validateFqn(args.fqn);
  return {
    fqn: args.fqn,
    origin: args.origin,
    description: args.description,
    version: args.version,
    prereqs: args.prereqs,
    dependencies: normaliseFqnDeps(AGENT_DEP_SPECS, args.dependencies),
    depsRefs: args.depsRefs ?? emptyOriginDeps(AGENT_DEP_SPECS),
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
function applyAgentAnchorPatch(
  state: AgentEntityState,
  raw: string,
  sourceLabel: string,
): AgentEntityState {
  const { meta } = parse(raw, sourceLabel);
  const newFqn = makeFqn(meta.scope, meta.shortName);
  if (newFqn !== state.fqn) {
    throw new TypeError(
      `AgentEntity.withAnchor cannot change identity: ` +
        `existing "${state.fqn}" vs new "${newFqn}". ` +
        "Delete and reinstall to rename.",
    );
  }
  return {
    ...state,
    description: meta.description,
    version: meta.version,
    prereqs: meta.prereqs,
    depsRefs: depsAsOrigins(meta),
    updatedAt: new Date().toISOString(),
  };
}

/** A resolved fqn-form dep reference. */
export type AgentDependencyRef = DependencyRef;

/** Resolved fqn-form deps view (catalog-side projection). */
export type AgentDependencies = FqnDeps<AgentDepKind>;

/** Frontmatter-declared dep origins (install-pipeline side). */
export type AgentDepRefs = OriginDeps<AgentDepKind>;

export class AgentEntity {
  private constructor(
    private readonly _state: AgentEntityState,
    private readonly _disabledByUser: boolean,
  ) {}

  static create(rawAgentMd: string, origin: string, sourceLabel: string): AgentEntity {
    return new AgentEntity(buildInitialAgentState(rawAgentMd, origin, sourceLabel), false);
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
    return new AgentEntity(
      buildStoredAgentState({
        fqn: args.fqn,
        origin: args.origin,
        description: args.description,
        version: args.version,
        prereqs: args.prereqs,
        dependencies: args.dependencies,
        prereqsAck: args.prereqsAck,
        installedAt: args.installedAt,
        updatedAt: args.updatedAt,
      }),
      args.disabledByUser,
    );
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
      applyAgentAnchorPatch(this._state, rawAgentMd, sourceLabel),
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

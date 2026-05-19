import * as AgentFormat from "./agent-frontmatter.js";
import { makeFqn, splitFqn, validateFqn } from "./validate.js";

/**
 * Rich domain entity representing a single installed agent.
 *
 * Identity = (fqn, origin), both immutable. Schema v2 (issue #122):
 *   - `scope` / `shortName` are derived getters off `fqn.split('/')`.
 *   - Anchor bytes (AGENTS.md) are no longer held on the entity; the
 *     repository's `getAnchor(fqn)` is the canonical fetch path.
 *   - `installedAt` / `updatedAt` ISO 8601 UTC timestamps surface on
 *     the entity so DTO projections can include them.
 *   - `dependencies` is the fqn-form view (populated by `fromStored`
 *     from the dep-tables join); freshly-created entities have empty
 *     `dependencies` because the install pipeline hasn't resolved
 *     origins to fqns yet. The frontmatter-declared origins live on
 *     {@link depsRefs} and drive that resolution.
 */
export class Agent {
  private constructor(
    private readonly _fqn: string,
    private readonly _origin: string,
    private readonly _description: string,
    private readonly _version: string,
    private readonly _prereqs: string | undefined,
    private readonly _dependencies: AgentDependencies,
    private readonly _depsRefs: AgentDepRefs,
    private readonly _prereqsAck: boolean,
    private readonly _disabledByUser: boolean,
    private readonly _installedAt: string,
    private readonly _updatedAt: string,
  ) {}

  static create(rawAgentMd: string, origin: string, sourceLabel: string): Agent {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("Agent.create requires a non-empty origin string");
    }
    const { meta } = AgentFormat.parse(rawAgentMd, sourceLabel);
    const fqn = makeFqn(meta.scope, meta.shortName);
    const prereqsAck = !hasNonEmptyPrereqs(meta.prereqs);
    const now = new Date().toISOString();
    return new Agent(
      fqn,
      origin,
      meta.description,
      meta.version,
      meta.prereqs,
      { skills: [], mcps: [] },
      normaliseDepRefs(meta.dependencies),
      prereqsAck,
      false,
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
    dependencies: AgentDependencies;
    prereqsAck: boolean;
    disabledByUser: boolean;
    installedAt: string;
    updatedAt: string;
  }): Agent {
    validateFqn(args.fqn);
    return new Agent(
      args.fqn,
      args.origin,
      args.description,
      args.version,
      args.prereqs,
      normaliseDeps(args.dependencies),
      { skills: [], mcps: [] },
      args.prereqsAck,
      args.disabledByUser,
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
  /**
   * Local-catalog dependency view: each entry is an fqn of an installed
   * sibling. Populated by `fromStored` (repository reads the dep tables);
   * freshly created entities expose empty arrays until the install
   * pipeline writes the dep rows.
   */
  get dependencies(): AgentDependencies {
    return this._dependencies;
  }
  /**
   * Origin URIs declared in the frontmatter `dependencies` block.
   * Used by the install pipeline to look up sibling fqns. Empty for
   * entities loaded via `fromStored` (origins aren't persisted past
   * install — only the resolved fqns are).
   */
  get depsRefs(): AgentDepRefs {
    return this._depsRefs;
  }
  get prereqsAck(): boolean {
    return this._prereqsAck;
  }
  get disabledByUser(): boolean {
    return this._disabledByUser;
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
      disabledByUser: this._disabledByUser,
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

  /**
   * Refresh frontmatter fields from a new anchor bytes (identity
   * unchanged); bumps `updatedAt`. The new anchor bytes themselves
   * are written by the repository (single source of truth in
   * `agent_files`); this method merely projects the updated metadata
   * and dep refs back onto the entity.
   */
  withAnchor(rawAgentMd: string, sourceLabel: string): Agent {
    const { meta } = AgentFormat.parse(rawAgentMd, sourceLabel);
    const newFqn = makeFqn(meta.scope, meta.shortName);
    if (newFqn !== this._fqn) {
      throw new TypeError(
        `Agent.withAnchor cannot change identity: existing "${this._fqn}" vs new "${newFqn}". ` +
          "Delete and reinstall to rename.",
      );
    }
    return new Agent(
      this._fqn,
      this._origin,
      meta.description,
      meta.version,
      meta.prereqs,
      this._dependencies,
      normaliseDepRefs(meta.dependencies),
      this._prereqsAck,
      this._disabledByUser,
      this._installedAt,
      new Date().toISOString(),
    );
  }

  /**
   * Return a new entity with one or more per-installation flags
   * replaced. Identity and frontmatter are preserved.
   */
  withState(state: { prereqsAck?: boolean; disabledByUser?: boolean }): Agent {
    return new Agent(
      this._fqn,
      this._origin,
      this._description,
      this._version,
      this._prereqs,
      this._dependencies,
      this._depsRefs,
      state.prereqsAck ?? this._prereqsAck,
      state.disabledByUser ?? this._disabledByUser,
      this._installedAt,
      this._updatedAt,
    );
  }

  /** Return a new entity carrying the given resolved fqn dependencies. */
  withDependencies(deps: AgentDependencies): Agent {
    return new Agent(
      this._fqn,
      this._origin,
      this._description,
      this._version,
      this._prereqs,
      normaliseDeps(deps),
      this._depsRefs,
      this._prereqsAck,
      this._disabledByUser,
      this._installedAt,
      this._updatedAt,
    );
  }
}

/** A resolved fqn-form dep reference. */
export interface AgentDependencyRef {
  readonly fqn: string;
}

export interface AgentDependencies {
  readonly skills: readonly AgentDependencyRef[];
  readonly mcps: readonly AgentDependencyRef[];
}

/** Origin URIs as declared in the frontmatter (pre-resolution). */
export interface AgentDepRefs {
  readonly skills: readonly string[];
  readonly mcps: readonly string[];
}

function normaliseDeps(
  deps:
    | { skills?: readonly AgentDependencyRef[]; mcps?: readonly AgentDependencyRef[] }
    | undefined,
): AgentDependencies {
  return {
    skills: deps?.skills ?? [],
    mcps: deps?.mcps ?? [],
  };
}

function normaliseDepRefs(
  deps: { skills?: readonly string[]; mcps?: readonly string[] } | undefined,
): AgentDepRefs {
  return {
    skills: deps?.skills ?? [],
    mcps: deps?.mcps ?? [],
  };
}

/** True iff `prereqs` is a non-empty, non-whitespace-only string. */
export function hasNonEmptyPrereqs(prereqs: string | undefined): boolean {
  return prereqs !== undefined && prereqs.trim().length > 0;
}

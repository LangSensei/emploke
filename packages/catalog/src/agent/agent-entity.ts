import * as AgentFormat from "./agent-frontmatter.js";
import { makeFqn, validateFqn } from "./validate.js";

/**
 * Rich domain entity representing a single installed agent.
 *
 * Identity = (fqn, origin), both immutable. See {@link Skill} for the
 * fqn-vs-name rationale and the **`version` authoring contract** (sync
 * and staleness keys off `version` alone — body / frontmatter edits
 * without a bump are no-ops). Differences from skills:
 *   - anchor file is `AGENTS.md`, not `SKILL.md`
 *   - agents are "root" entities — never dep-referenced; only have
 *     outgoing deps (skills + mcps)
 *
 * Per-installation flags (NOT in frontmatter — local opt-ins):
 *   - `prereqsAck`: user has acknowledged the entry's `prereqs` text
 *     (or the entry has none).
 *   - `disabledByUser`: user explicitly disabled this agent. Skills
 *     and mcps don't have this flag — only agents are user-launchable
 *     units worth pausing.
 */
export class Agent {
  private constructor(
    private readonly _fqn: string,
    private readonly _origin: string,
    private readonly _scope: string,
    private readonly _shortName: string,
    private readonly _description: string,
    private readonly _version: string,
    private readonly _prereqs: string | undefined,
    private readonly _dependencies: AgentDependencies,
    private readonly _anchorContent: string,
    private readonly _prereqsAck: boolean,
    private readonly _disabledByUser: boolean,
  ) {}

  static create(rawAgentMd: string, origin: string, sourceLabel: string): Agent {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("Agent.create requires a non-empty origin string");
    }
    const { meta } = AgentFormat.parse(rawAgentMd, sourceLabel);
    const fqn = makeFqn(meta.scope, meta.shortName);
    const prereqsAck = !hasNonEmptyPrereqs(meta.prereqs);
    return new Agent(
      fqn,
      origin,
      meta.scope,
      meta.shortName,
      meta.description,
      meta.version,
      meta.prereqs,
      normaliseDeps(meta.dependencies),
      rawAgentMd,
      prereqsAck,
      false,
    );
  }

  static fromStored(args: {
    fqn: string;
    origin: string;
    scope: string;
    shortName: string;
    description: string;
    version: string;
    prereqs: string | undefined;
    dependencies: AgentDependencies;
    anchorContent: string;
    prereqsAck: boolean;
    disabledByUser: boolean;
  }): Agent {
    validateFqn(args.fqn);
    return new Agent(
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
      args.disabledByUser,
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
  get dependencies(): AgentDependencies {
    return this._dependencies;
  }
  get anchorContent(): string {
    return this._anchorContent;
  }
  get prereqsAck(): boolean {
    return this._prereqsAck;
  }
  get disabledByUser(): boolean {
    return this._disabledByUser;
  }

  toJSON(): Record<string, unknown> {
    return {
      fqn: this._fqn,
      shortName: this._shortName,
      scope: this._scope,
      origin: this._origin,
      description: this._description,
      version: this._version,
      prereqsAck: this._prereqsAck,
      disabledByUser: this._disabledByUser,
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
      meta.scope,
      meta.shortName,
      meta.description,
      meta.version,
      meta.prereqs,
      normaliseDeps(meta.dependencies),
      rawAgentMd,
      this._prereqsAck,
      this._disabledByUser,
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
      this._scope,
      this._shortName,
      this._description,
      this._version,
      this._prereqs,
      this._dependencies,
      this._anchorContent,
      state.prereqsAck ?? this._prereqsAck,
      state.disabledByUser ?? this._disabledByUser,
    );
  }
}

/** A dep reference is just an origin URI string. */
export type AgentDependencyRef = string;

export interface AgentDependencies {
  readonly skills: readonly AgentDependencyRef[];
  readonly mcps: readonly AgentDependencyRef[];
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

/** True iff `prereqs` is a non-empty, non-whitespace-only string. */
export function hasNonEmptyPrereqs(prereqs: string | undefined): boolean {
  return prereqs !== undefined && prereqs.trim().length > 0;
}

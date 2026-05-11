import { createHash } from "node:crypto";
import type { AgentFrontmatter } from "./agent-frontmatter.js";
import * as AgentFormat from "./agent-frontmatter.js";
import { makeFqn, validateFqn } from "./validate.js";

/**
 * Rich domain entity representing a single installed agent.
 *
 * Identity = (fqn, origin), both immutable. See {@link Skill} for the
 * fqn-vs-name rationale. Differences from skills:
 *   - anchor file is `AGENTS.md`, not `SKILL.md`
 *   - no `prereqs` field
 *   - agents are "root" entities — never dep-referenced; only have
 *     outgoing deps (skills + mcps)
 */
export class Agent {
  private constructor(
    private readonly _fqn: string,
    private readonly _origin: string,
    private readonly _scope: string,
    private readonly _shortName: string,
    private readonly _description: string,
    private readonly _version: string,
    private readonly _dependencies: AgentDependencies,
    private readonly _anchorContent: string,
  ) {}

  static create(rawAgentMd: string, origin: string, sourceLabel: string): Agent {
    if (typeof origin !== "string" || origin.length === 0) {
      throw new TypeError("Agent.create requires a non-empty origin string");
    }
    const { meta } = AgentFormat.parse(rawAgentMd, sourceLabel);
    const fqn = makeFqn(meta.scope, meta.shortName);
    return new Agent(
      fqn,
      origin,
      meta.scope,
      meta.shortName,
      meta.description,
      meta.version,
      normaliseDeps(meta.dependencies),
      rawAgentMd,
    );
  }

  static fromStored(args: {
    fqn: string;
    origin: string;
    scope: string;
    shortName: string;
    description: string;
    version: string;
    dependencies: AgentDependencies;
    anchorContent: string;
  }): Agent {
    validateFqn(args.fqn);
    return new Agent(
      args.fqn,
      args.origin,
      args.scope,
      args.shortName,
      args.description,
      args.version,
      normaliseDeps(args.dependencies),
      args.anchorContent,
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
  get dependencies(): AgentDependencies {
    return this._dependencies;
  }
  get anchorContent(): string {
    return this._anchorContent;
  }

  get frontmatterSha256(): string {
    return canonicalFrontmatterSha(this.frontmatterView);
  }

  private get frontmatterView(): AgentFrontmatter {
    return {
      shortName: this._shortName,
      scope: this._scope,
      description: this._description,
      version: this._version,
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

  toJSON(): Record<string, unknown> {
    return {
      fqn: this._fqn,
      shortName: this._shortName,
      scope: this._scope,
      origin: this._origin,
      description: this._description,
      version: this._version,
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
      normaliseDeps(meta.dependencies),
      rawAgentMd,
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

export function canonicalFrontmatterSha(meta: AgentFrontmatter): string {
  const canonical = JSON.stringify(canonicalise(meta));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalise(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      const v = obj[k];
      if (v !== undefined) out[k] = canonicalise(v);
    }
    return out;
  }
  return value;
}

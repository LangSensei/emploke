import { type DepSpec, defineDepSpecs } from "../_shared/dep-keys.js";
import {
  type AnchoredDependencyRef,
  type AnchoredFrontmatter,
  makeFrontmatterCodec,
  type ParsedAnchoredMd,
} from "../_shared/frontmatter-codec.js";
import { AgentFrontmatterError } from "./errors.js";
import { DEFAULT_SCOPE, validateScope, validateShortName } from "./validate.js";

/**
 * AGENTS.md frontmatter codec. Thin shadow over the shared
 * `_shared/frontmatter-codec.ts` factory — see that module for the
 * grammar and the rationale for the dep-ref list schema.
 *
 * Behavior change (F2-1 disclosed in PR body): the legacy
 * `{ origin: "…" }` object form for `dependencies.skills[*]` /
 * `dependencies.mcps[*]` is no longer accepted. Only string items
 * are valid, matching skill-frontmatter's existing schema. No
 * first-party or marketplace agent uses the object form; third-party
 * authors that do will receive a clear AgentFrontmatterError on
 * first install attempt.
 */

export type AgentDepKind = "skills" | "mcps";

/**
 * Per-kind dep-spec set — the single source of truth for the agent
 * kind. The entity, repository, and service files all import this
 * directly; nothing redeclares the `{skills, mcps}` shape elsewhere.
 *
 * Lives in `agent-frontmatter.ts` (not `agent-entity.ts`) because the
 * frontmatter codec already needs these specs to derive its accepted
 * dep-key set. Moving the spec set into the entity would require
 * `agent-frontmatter.ts` to import a value from `agent-entity.ts`,
 * which would create a runtime import cycle (entity already imports
 * `parse` / `writeFrontmatter` from this file).
 *
 * DO NOT move this constant to `agent-entity.ts` or to a sibling
 * `agent-deps.ts` file — either reintroduces the cycle
 * (entity ↔ frontmatter), and the third-file split adds a module
 * for no semantic gain.
 */
export const AGENT_DEP_SPECS: readonly DepSpec<AgentDepKind>[] = defineDepSpecs<AgentDepKind>(
  { kind: "skills" },
  { kind: "mcps" },
);

const codec = makeFrontmatterCodec<AgentDepKind>({
  anchorFilename: "AGENTS.md",
  ErrorClass: AgentFrontmatterError,
  validators: { validateScope, validateShortName, DEFAULT_SCOPE },
  depSpecs: AGENT_DEP_SPECS,
});

export type AgentDependencyRef = AnchoredDependencyRef;

export type AgentFrontmatter = AnchoredFrontmatter<AgentDepKind>;
export type ParsedAgentMd = ParsedAnchoredMd<AgentDepKind>;

export const parse: (content: string, sourceLabel: string) => ParsedAgentMd = codec.parse;
export const writeFrontmatter: (
  content: string,
  meta: AgentFrontmatter,
  sourceLabel: string,
) => string = codec.writeFrontmatter;

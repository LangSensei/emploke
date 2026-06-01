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

const AGENT_DEP_KEYS = ["skills", "mcps"] as const satisfies readonly AgentDepKind[];

const codec = makeFrontmatterCodec<AgentDepKind>({
  anchorFilename: "AGENTS.md",
  ErrorClass: AgentFrontmatterError,
  validators: { validateScope, validateShortName, DEFAULT_SCOPE },
  depKeys: AGENT_DEP_KEYS,
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

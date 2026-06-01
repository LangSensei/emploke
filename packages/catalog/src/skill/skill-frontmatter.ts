import {
  type AnchoredDependencyRef,
  type AnchoredFrontmatter,
  makeFrontmatterCodec,
  type ParsedAnchoredMd,
} from "../_shared/frontmatter-codec.js";
import { SkillFrontmatterError } from "./errors.js";
import { DEFAULT_SCOPE, validateScope, validateShortName } from "./validate.js";

/**
 * SKILL.md frontmatter codec. Thin shadow over the shared
 * `_shared/frontmatter-codec.ts` factory — see that module for the
 * grammar and the rationale for the dep-ref list schema.
 *
 * Format: a YAML frontmatter block delimited by `---` lines at the top
 * of a markdown document, followed by the body. Example:
 *
 *   ---
 *   name: tool-use            # short, kebab; emploke adds `scope:` for FQN
 *   scope: public             # optional, defaults to "public"
 *   description: Helpful tool-use patterns
 *   version: 1.0.0
 *   dependencies:
 *     skills:
 *       - "github:owner/repo/tree/main/skills/web-search"
 *     mcps:
 *       - "file:/abs/path/mcps/azure"
 *   ---
 *   # Tool use
 *
 *   Body markdown here.
 *
 * Identity rules:
 *   - `name:` is the SHORT identifier ("tool-use"), not a full FQN.
 *     Slashes are forbidden.
 *   - `scope:` is the local-namespace segment (default `"public"`).
 *   - The catalog identity (FQN) is computed as `<scope>/<name>`.
 *
 * Dep refs are bare origin strings. The dep's identity is computed at
 * resolve time by fetching the referenced anchor; the author writes
 * only the URI ("where to find it"), not the FQN ("how to call it").
 */

export type SkillDepKind = "skills" | "mcps";

const SKILL_DEP_KEYS = ["skills", "mcps"] as const satisfies readonly SkillDepKind[];

const codec = makeFrontmatterCodec<SkillDepKind>({
  anchorFilename: "SKILL.md",
  ErrorClass: SkillFrontmatterError,
  validators: { validateScope, validateShortName, DEFAULT_SCOPE },
  depKeys: SKILL_DEP_KEYS,
});

export type SkillDependencyRef = AnchoredDependencyRef;

export type SkillFrontmatter = AnchoredFrontmatter<SkillDepKind>;
export type ParsedSkillMd = ParsedAnchoredMd<SkillDepKind>;

export const parse: (content: string, sourceLabel: string) => ParsedSkillMd = codec.parse;
export const writeFrontmatter: (
  content: string,
  meta: SkillFrontmatter,
  sourceLabel: string,
) => string = codec.writeFrontmatter;

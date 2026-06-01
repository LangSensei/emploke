import { type DepSpec, defineDepSpecs } from "../_shared/dep-keys.js";
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

/**
 * Per-kind dep-spec set — the single source of truth for the skill
 * kind. The entity, repository, and service files all import this
 * directly; nothing redeclares the `{skills, mcps}` shape elsewhere.
 *
 * Lives in `skill-frontmatter.ts` (not `skill-entity.ts`) because the
 * frontmatter codec already needs these specs to derive its accepted
 * dep-key set. Moving the spec set into the entity would require
 * `skill-frontmatter.ts` to import a value from `skill-entity.ts`,
 * which would create a runtime import cycle (entity already imports
 * `parse` / `writeFrontmatter` from this file).
 *
 * DO NOT move this constant to `skill-entity.ts` or to a sibling
 * `skill-deps.ts` file — either reintroduces the cycle
 * (entity ↔ frontmatter), and the third-file split adds a module
 * for no semantic gain.
 *
 * `skipSelf: true` on the `skills` bucket means a skill that lists
 * itself as a skill-dep silently drops the self-edge at write time
 * (a typo, not a graph cycle to honour).
 */
export const SKILL_DEP_SPECS: readonly DepSpec<SkillDepKind>[] = defineDepSpecs<SkillDepKind>(
  { kind: "skills", skipSelf: true },
  { kind: "mcps" },
);

const codec = makeFrontmatterCodec<SkillDepKind>({
  anchorFilename: "SKILL.md",
  ErrorClass: SkillFrontmatterError,
  validators: { validateScope, validateShortName, DEFAULT_SCOPE },
  depSpecs: SKILL_DEP_SPECS,
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

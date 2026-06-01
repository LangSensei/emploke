import yaml from "js-yaml";
import { type DepSpec, defineDepSpecs } from "../_shared/dep-keys.js";
import { SkillFrontmatterError } from "./errors.js";
import { DEFAULT_SCOPE, validateScope, validateShortName } from "./validate.js";

/**
 * SKILL.md frontmatter codec. Owned entirely by `skill/` per the
 * decoupling-over-abstraction axiom — skill and agent happen to share
 * the same frontmatter contract today, but a shared abstraction would
 * force coordinated changes the moment either kind gains a field.
 * MCP is the proof-of-existence for per-kind autonomy.
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
 *
 * The agent mirror in `agent/agent-frontmatter.ts` is byte-equivalent
 * to this codec apart from the error class, anchor filename, and the
 * AGENT_DEP_SPECS lacking the `skipSelf: true` flag on the `skills`
 * bucket (agents are top-of-graph and can't self-cycle in practice).
 * Maintainers MUST NOT extract a shared factory — see
 * skill-entity.ts header.
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
 * `parse` / writeFrontmatter from this file).
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

/** A dep reference as it appears in the SKILL.md wire shape: a bare origin URI. */
export type SkillDependencyRef = string;

export interface SkillFrontmatter {
  readonly shortName: string;
  readonly scope: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs?: string;
  /** Partial: any subset of `SkillDepKind` may be absent. */
  readonly dependencies?: Partial<Record<SkillDepKind, readonly SkillDependencyRef[]>>;
}

export interface ParsedSkillMd {
  readonly meta: SkillFrontmatter;
  readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)---\r?\n?/;
const KNOWN_DEP_KEYS: ReadonlySet<string> = new Set(SKILL_DEP_SPECS.map((s) => s.kind));

export function parse(content: string, sourceLabel: string): ParsedSkillMd {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new SkillFrontmatterError(
      sourceLabel,
      "missing frontmatter block (SKILL.md must start with `---` ... `---`)",
    );
  }
  const yamlText = match[1] ?? "";
  const body = content.slice(match[0].length);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (cause) {
    throw new SkillFrontmatterError(sourceLabel, (cause as Error).message, { cause });
  }
  if (parsed === null || parsed === undefined) {
    throw new SkillFrontmatterError(sourceLabel, "frontmatter block is empty");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillFrontmatterError(sourceLabel, "frontmatter must be a YAML mapping");
  }
  const data = parsed as Record<string, unknown>;
  const meta = projectFrontmatter(data, sourceLabel);
  return { meta, body };
}

export function writeFrontmatter(
  content: string,
  meta: SkillFrontmatter,
  _sourceLabel: string,
): string {
  const match = content.match(FRONTMATTER_RE);
  const body = match ? content.slice(match[0].length) : content;
  const yamlText = serializeFrontmatter(meta);
  return `---\n${yamlText}---\n${body}`;
}

function projectFrontmatter(data: Record<string, unknown>, sourceLabel: string): SkillFrontmatter {
  const { name, scope, description, version, prereqs, dependencies } = data;

  if (typeof name !== "string" || name.length === 0) {
    throw new SkillFrontmatterError(sourceLabel, "missing or non-string `name`");
  }
  validateShortName(name);

  const resolvedScope = scope === undefined ? DEFAULT_SCOPE : scope;
  validateScope(resolvedScope);

  if (typeof description !== "string") {
    throw new SkillFrontmatterError(sourceLabel, "missing or non-string `description`");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new SkillFrontmatterError(sourceLabel, "missing or empty `version`");
  }
  if (prereqs !== undefined && typeof prereqs !== "string") {
    throw new SkillFrontmatterError(sourceLabel, "`prereqs` must be a string when present");
  }
  const deps = parseDependencies(dependencies, sourceLabel);

  return {
    shortName: name,
    scope: resolvedScope,
    description,
    version,
    ...(prereqs !== undefined ? { prereqs } : {}),
    ...(deps !== undefined ? { dependencies: deps } : {}),
  };
}

function parseDependencies(
  raw: unknown,
  sourceLabel: string,
): Partial<Record<SkillDepKind, readonly SkillDependencyRef[]>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SkillFrontmatterError(sourceLabel, "`dependencies` must be a mapping");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<Record<SkillDepKind, readonly SkillDependencyRef[]>> = {};
  for (const k of Object.keys(obj)) {
    if (!KNOWN_DEP_KEYS.has(k)) continue;
    const items = obj[k];
    if (items === undefined) continue;
    out[k as SkillDepKind] = parseDependencyList(items, k, sourceLabel);
  }
  return out;
}

function parseDependencyList(
  raw: unknown,
  field: string,
  sourceLabel: string,
): SkillDependencyRef[] {
  if (!Array.isArray(raw)) {
    throw new SkillFrontmatterError(sourceLabel, `\`dependencies.${field}\` must be an array`);
  }
  return raw.map((item, idx) => {
    if (typeof item !== "string") {
      throw new SkillFrontmatterError(
        sourceLabel,
        `\`dependencies.${field}[${idx}]\` must be an origin URI string ` +
          '(e.g. "github:owner/repo/tree/main/skills/foo")',
      );
    }
    if (item.length === 0) {
      throw new SkillFrontmatterError(
        sourceLabel,
        `\`dependencies.${field}[${idx}]\` must be a non-empty origin URI`,
      );
    }
    return item;
  });
}

function serializeFrontmatter(meta: SkillFrontmatter): string {
  const obj: Record<string, unknown> = {
    name: meta.shortName,
    scope: meta.scope,
    description: meta.description,
    version: meta.version,
  };
  if (meta.prereqs !== undefined) obj.prereqs = meta.prereqs;
  if (meta.dependencies !== undefined) obj.dependencies = meta.dependencies;
  return yaml.dump(obj, { lineWidth: -1, noRefs: true });
}

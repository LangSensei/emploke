import yaml from "js-yaml";
import { SkillFrontmatterError } from "./errors.js";
import { DEFAULT_SCOPE, validateScope, validateShortName } from "./validate.js";

/**
 * SKILL.md frontmatter codec — pure, side-effect-free, I/O-free.
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
 * This is the de-centralised model — origins are URLs (globally
 * unique by URL), so no extra naming coordination is required.
 */

/** A dep reference is just an origin URI string. */
export type SkillDependencyRef = string;

export interface SkillFrontmatter {
  /** Short kebab-case name (NOT the FQN). */
  readonly shortName: string;
  /** Scope segment. Defaults to `DEFAULT_SCOPE` ("public") when omitted. */
  readonly scope: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs?: string;
  readonly dependencies?: {
    readonly skills?: readonly SkillDependencyRef[];
    readonly mcps?: readonly SkillDependencyRef[];
  };
}

export interface ParsedSkillMd {
  readonly meta: SkillFrontmatter;
  /** The markdown body after the frontmatter block (verbatim). */
  readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)---\r?\n?/;

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
): { skills?: SkillDependencyRef[]; mcps?: SkillDependencyRef[] } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SkillFrontmatterError(sourceLabel, "`dependencies` must be a mapping");
  }
  const obj = raw as Record<string, unknown>;
  const out: { skills?: SkillDependencyRef[]; mcps?: SkillDependencyRef[] } = {};
  if (obj.skills !== undefined) {
    out.skills = parseDependencyList(obj.skills, "skills", sourceLabel);
  }
  if (obj.mcps !== undefined) {
    out.mcps = parseDependencyList(obj.mcps, "mcps", sourceLabel);
  }
  return out;
}

/**
 * Parse a `dependencies.skills` / `dependencies.mcps` list. Accepts:
 *   - A bare origin string: `- "file:/abs/path"`
 *   - An object with `{ origin: string }` (legacy / explicit form,
 *     transparently coerced to the string form for downstream code).
 *
 * The object form is permitted to make migration from the older
 * `{ name, origin, scope? }` shape less abrupt — authors who delete
 * `name` and `scope` end up with `{ origin }`, which still parses.
 */
function parseDependencyList(
  raw: unknown,
  field: string,
  sourceLabel: string,
): SkillDependencyRef[] {
  if (!Array.isArray(raw)) {
    throw new SkillFrontmatterError(sourceLabel, `\`dependencies.${field}\` must be an array`);
  }
  return raw.map((item, idx) => {
    if (typeof item === "string") {
      if (item.length === 0) {
        throw new SkillFrontmatterError(
          sourceLabel,
          `\`dependencies.${field}[${idx}]\` must be a non-empty origin URI`,
        );
      }
      return item;
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.origin === "string" && obj.origin.length > 0) return obj.origin;
    }
    throw new SkillFrontmatterError(
      sourceLabel,
      `\`dependencies.${field}[${idx}]\` must be an origin URI string ` +
        '(e.g. "github:owner/repo/tree/main/skills/foo")',
    );
  });
}

/**
 * Replace the frontmatter block of a SKILL.md document with the given
 * `meta`, preserving the body byte-for-byte.
 */
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

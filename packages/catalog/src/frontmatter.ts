import yaml from "js-yaml";
import { FrontmatterError } from "./errors.js";
import type { Skill } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Parse a SKILL.md-style document: YAML frontmatter delimited by `---` lines,
 * followed by an optional Markdown body.
 *
 * Returns the raw frontmatter object and the body. If no frontmatter is
 * present, returns an empty object and the entire content as body.
 *
 * Throws {@link FrontmatterError} when the YAML is malformed or evaluates to
 * a non-object value.
 */
export function parseFrontmatter(
  source: string,
  sourcePath: string,
): { data: Record<string, unknown>; body: string } {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { data: {}, body: source };
  }
  const yamlText = match[1] ?? "";
  const body = source.slice(match[0].length);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (cause) {
    throw new FrontmatterError(sourcePath, (cause as Error).message, { cause });
  }
  if (parsed === null || parsed === undefined) {
    return { data: {}, body };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FrontmatterError(sourcePath, "frontmatter must be a YAML mapping (object)");
  }
  return { data: parsed as Record<string, unknown>, body };
}

/**
 * Project a frontmatter object into the {@link Skill} fields emploke cares
 * about. Other fields are intentionally ignored — they remain on disk but
 * are not exposed through the catalog API.
 *
 * Defaulting rules:
 *  - `version` is required by the {@link Skill} type. If frontmatter omits it,
 *    emploke fills `"0.0.1"` here in memory only; the source file is never
 *    rewritten.
 *  - `dependencies` is left out (undefined) when absent.
 */
export function frontmatterToSkill(data: Record<string, unknown>, sourcePath: string): Skill {
  const name = data.name;
  const description = data.description;
  const version = data.version;
  const type = data.type;
  const dependencies = data.dependencies;

  if (typeof name !== "string" || name.length === 0) {
    throw new FrontmatterError(sourcePath, "missing or non-string `name`");
  }
  if (typeof description !== "string") {
    throw new FrontmatterError(sourcePath, "missing or non-string `description`");
  }
  if (version !== undefined && typeof version !== "string") {
    throw new FrontmatterError(sourcePath, "`version` must be a string when present");
  }
  if (type !== undefined && typeof type !== "string") {
    throw new FrontmatterError(sourcePath, "`type` must be a string when present");
  }

  const skill: Skill = {
    name,
    description,
    version: version ?? "0.0.1",
    ...(type !== undefined ? { type } : {}),
    ...(dependencies !== undefined
      ? { dependencies: parseDependencies(dependencies, sourcePath) }
      : {}),
  };
  return skill;
}

function parseDependencies(
  raw: unknown,
  sourcePath: string,
): { skills?: readonly string[]; mcps?: readonly string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FrontmatterError(
      sourcePath,
      "`dependencies` must be a mapping with optional `skills` and `mcps` arrays",
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: { skills?: readonly string[]; mcps?: readonly string[] } = {};
  if (obj.skills !== undefined) {
    out.skills = parseStringArray(obj.skills, sourcePath, "dependencies.skills");
  }
  if (obj.mcps !== undefined) {
    out.mcps = parseStringArray(obj.mcps, sourcePath, "dependencies.mcps");
  }
  return out;
}

function parseStringArray(raw: unknown, sourcePath: string, field: string): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new FrontmatterError(sourcePath, `\`${field}\` must be an array of strings`);
  }
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0) {
      throw new FrontmatterError(sourcePath, `\`${field}\` entries must be non-empty strings`);
    }
  }
  return raw as readonly string[];
}

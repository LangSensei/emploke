import yaml from "js-yaml";
import { FrontmatterError } from "./errors.js";
import type { Agent, Skill } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Parse YAML frontmatter from a markdown document.
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
 * Project frontmatter into a Skill.
 */
export function frontmatterToSkill(data: Record<string, unknown>, sourcePath: string): Skill {
  const name = data.name;
  const description = data.description;
  const version = data.version;
  const dependencies = data.dependencies;
  const prereqs = data.prereqs;

  if (typeof name !== "string" || name.length === 0) {
    throw new FrontmatterError(sourcePath, "missing or non-string `name`");
  }
  if (typeof description !== "string") {
    throw new FrontmatterError(sourcePath, "missing or non-string `description`");
  }
  if (version !== undefined && typeof version !== "string") {
    throw new FrontmatterError(sourcePath, "`version` must be a string when present");
  }
  if (prereqs !== undefined && typeof prereqs !== "string") {
    throw new FrontmatterError(sourcePath, "`prereqs` must be a string when present");
  }

  return {
    name,
    description,
    version: (version as string) ?? "0.0.1",
    ...(dependencies !== undefined
      ? { dependencies: parseDependencies(dependencies, sourcePath) }
      : {}),
    ...(prereqs !== undefined ? { prereqs: prereqs as string } : {}),
  };
}

/**
 * Project frontmatter into an Agent.
 */
export function frontmatterToAgent(data: Record<string, unknown>, sourcePath: string): Agent {
  const name = data.name;
  const description = data.description;
  const version = data.version;
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

  return {
    name,
    description,
    version: (version as string) ?? "0.0.1",
    ...(dependencies !== undefined
      ? { dependencies: parseDependencies(dependencies, sourcePath) }
      : {}),
  };
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

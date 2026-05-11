import yaml from "js-yaml";
import { AgentFrontmatterError } from "./errors.js";
import { DEFAULT_SCOPE, validateScope, validateShortName } from "./validate.js";

/**
 * AGENTS.md frontmatter codec. See SKILL.md format for the general
 * shape; agents differ in:
 *   - no `prereqs` field (skill-only)
 *   - else identical structure
 *
 * Dep refs are bare origin strings (de-centralised model — see
 * skill-frontmatter for rationale).
 */

/** A dep reference is just an origin URI string. */
export type AgentDependencyRef = string;

export interface AgentFrontmatter {
  readonly shortName: string;
  readonly scope: string;
  readonly description: string;
  readonly version: string;
  readonly dependencies?: {
    readonly skills?: readonly AgentDependencyRef[];
    readonly mcps?: readonly AgentDependencyRef[];
  };
}

export interface ParsedAgentMd {
  readonly meta: AgentFrontmatter;
  readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)---\r?\n?/;

export function parse(content: string, sourceLabel: string): ParsedAgentMd {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new AgentFrontmatterError(
      sourceLabel,
      "missing frontmatter block (AGENTS.md must start with `---` ... `---`)",
    );
  }
  const yamlText = match[1] ?? "";
  const body = content.slice(match[0].length);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (cause) {
    throw new AgentFrontmatterError(sourceLabel, (cause as Error).message, { cause });
  }
  if (parsed === null || parsed === undefined) {
    throw new AgentFrontmatterError(sourceLabel, "frontmatter block is empty");
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentFrontmatterError(sourceLabel, "frontmatter must be a YAML mapping");
  }
  const data = parsed as Record<string, unknown>;
  const meta = projectFrontmatter(data, sourceLabel);
  return { meta, body };
}

function projectFrontmatter(data: Record<string, unknown>, sourceLabel: string): AgentFrontmatter {
  const { name, scope, description, version, dependencies } = data;

  if (typeof name !== "string" || name.length === 0) {
    throw new AgentFrontmatterError(sourceLabel, "missing or non-string `name`");
  }
  validateShortName(name);

  const resolvedScope = scope === undefined ? DEFAULT_SCOPE : scope;
  validateScope(resolvedScope);

  if (typeof description !== "string") {
    throw new AgentFrontmatterError(sourceLabel, "missing or non-string `description`");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new AgentFrontmatterError(sourceLabel, "missing or empty `version`");
  }
  if (data.prereqs !== undefined) {
    throw new AgentFrontmatterError(
      sourceLabel,
      "agents do not support `prereqs`; embed setup guidance in the body instead",
    );
  }
  const deps = parseDependencies(dependencies, sourceLabel);

  return {
    shortName: name,
    scope: resolvedScope,
    description,
    version,
    ...(deps !== undefined ? { dependencies: deps } : {}),
  };
}

function parseDependencies(
  raw: unknown,
  sourceLabel: string,
): { skills?: AgentDependencyRef[]; mcps?: AgentDependencyRef[] } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentFrontmatterError(sourceLabel, "`dependencies` must be a mapping");
  }
  const obj = raw as Record<string, unknown>;
  const out: { skills?: AgentDependencyRef[]; mcps?: AgentDependencyRef[] } = {};
  if (obj.skills !== undefined) {
    out.skills = parseDependencyList(obj.skills, "skills", sourceLabel);
  }
  if (obj.mcps !== undefined) {
    out.mcps = parseDependencyList(obj.mcps, "mcps", sourceLabel);
  }
  return out;
}

function parseDependencyList(
  raw: unknown,
  field: string,
  sourceLabel: string,
): AgentDependencyRef[] {
  if (!Array.isArray(raw)) {
    throw new AgentFrontmatterError(sourceLabel, `\`dependencies.${field}\` must be an array`);
  }
  return raw.map((item, idx) => {
    if (typeof item === "string") {
      if (item.length === 0) {
        throw new AgentFrontmatterError(
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
    throw new AgentFrontmatterError(
      sourceLabel,
      `\`dependencies.${field}[${idx}]\` must be an origin URI string ` +
        '(e.g. "github:owner/repo/tree/main/skills/foo")',
    );
  });
}

export function writeFrontmatter(
  content: string,
  meta: AgentFrontmatter,
  _sourceLabel: string,
): string {
  const match = content.match(FRONTMATTER_RE);
  const body = match ? content.slice(match[0].length) : content;
  const yamlText = serializeFrontmatter(meta);
  return `---\n${yamlText}---\n${body}`;
}

function serializeFrontmatter(meta: AgentFrontmatter): string {
  const obj: Record<string, unknown> = {
    name: meta.shortName,
    scope: meta.scope,
    description: meta.description,
    version: meta.version,
  };
  if (meta.dependencies !== undefined) obj.dependencies = meta.dependencies;
  return yaml.dump(obj, { lineWidth: -1, noRefs: true });
}

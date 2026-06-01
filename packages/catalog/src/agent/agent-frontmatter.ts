import yaml from "js-yaml";
import { type DepSpec, defineDepSpecs } from "../_shared/dep-keys.js";
import { AgentFrontmatterError } from "./errors.js";
import { DEFAULT_SCOPE, validateScope, validateShortName } from "./validate.js";

/**
 * AGENTS.md frontmatter codec. Owned entirely by `agent/` per the
 * decoupling-over-abstraction axiom — agent and skill happen to share
 * the same frontmatter contract today, but a shared abstraction would
 * force coordinated changes the moment either kind gains a field.
 * MCP is the proof-of-existence for per-kind autonomy.
 *
 * The frontmatter grammar (identical to skill's today; diverges per
 * kind once either side adds a field — that divergence happens here,
 * not in a shared module, by design):
 *
 *   ---
 *   name: <short-kebab>
 *   scope: <scope>            # optional, defaults to "public"
 *   description: <text>
 *   version: <semver-ish>
 *   prereqs: <text>           # optional
 *   dependencies:             # optional
 *     skills: [<origin>, ...]
 *     mcps:   [<origin>, ...]
 *   ---
 *   <body markdown>
 *
 * The skill mirror in `skill/skill-frontmatter.ts` is byte-equivalent
 * to this codec apart from the error class, anchor filename, and the
 * SKILL_DEP_SPECS `skipSelf: true` on the `skills` bucket. Maintainers
 * MUST NOT extract a shared factory — see agent-entity.ts header.
 *
 * Behavior change (F2-1, disclosed in PR body and still in effect):
 * the legacy `{ origin: "…" }` object form for `dependencies.<kind>[*]`
 * is no longer accepted. Only string items are valid, matching the
 * skill-side schema. No first-party or marketplace agent uses the
 * object form; third-party authors that do will receive a clear
 * AgentFrontmatterError on first install attempt.
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
 * `parse` / writeFrontmatter from this file).
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

/** A dep reference as it appears in the AGENTS.md wire shape: a bare origin URI. */
export type AgentDependencyRef = string;

export interface AgentFrontmatter {
  readonly shortName: string;
  readonly scope: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs?: string;
  /** Partial: any subset of `AgentDepKind` may be absent. */
  readonly dependencies?: Partial<Record<AgentDepKind, readonly AgentDependencyRef[]>>;
}

export interface ParsedAgentMd {
  readonly meta: AgentFrontmatter;
  readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)---\r?\n?/;
const KNOWN_DEP_KEYS: ReadonlySet<string> = new Set(AGENT_DEP_SPECS.map((s) => s.kind));

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

function projectFrontmatter(data: Record<string, unknown>, sourceLabel: string): AgentFrontmatter {
  const { name, scope, description, version, prereqs, dependencies } = data;

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
  if (prereqs !== undefined && typeof prereqs !== "string") {
    throw new AgentFrontmatterError(sourceLabel, "`prereqs` must be a string when present");
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
): Partial<Record<AgentDepKind, readonly AgentDependencyRef[]>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentFrontmatterError(sourceLabel, "`dependencies` must be a mapping");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<Record<AgentDepKind, readonly AgentDependencyRef[]>> = {};
  for (const k of Object.keys(obj)) {
    if (!KNOWN_DEP_KEYS.has(k)) continue;
    const items = obj[k];
    if (items === undefined) continue;
    out[k as AgentDepKind] = parseDependencyList(items, k, sourceLabel);
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
    if (typeof item !== "string") {
      throw new AgentFrontmatterError(
        sourceLabel,
        `\`dependencies.${field}[${idx}]\` must be an origin URI string ` +
          '(e.g. "github:owner/repo/tree/main/skills/foo")',
      );
    }
    if (item.length === 0) {
      throw new AgentFrontmatterError(
        sourceLabel,
        `\`dependencies.${field}[${idx}]\` must be a non-empty origin URI`,
      );
    }
    return item;
  });
}

function serializeFrontmatter(meta: AgentFrontmatter): string {
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

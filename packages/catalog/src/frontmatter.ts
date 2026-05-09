import yaml from "js-yaml";
import { FrontmatterError, OriginParseError } from "./errors.js";
import { type ParsedOrigin, parseOrigin, scopeFromOrigin } from "./origin.js";
import type { Agent, DependencyRef, Skill } from "./types.js";
import { makeFqn, validateScope, validateShortName } from "./validate.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Build a synthetic origin URI from a `sourcePath`. Used by the catalog
 * layer when the frontmatter omits `origin` (legacy / test fixtures /
 * direct local installs without explicit URI).
 *
 * The fallback is always a `file:` scheme so {@link scopeFromOrigin}
 * yields the literal `local`. We accept any sourcePath shape — the
 * `Fs*Repository` impls pass real OS paths, the in-memory impls pass
 * synthetic identifiers (e.g. `memory:skills/foo/SKILL.md`); both produce
 * valid `file:` URIs that downstream code treats the same way.
 */
export function synthesizeOriginFromPath(sourcePath: string): string {
  return `file:${sourcePath}`;
}

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
 * Apply a partial patch to the frontmatter of a raw markdown document.
 *
 * - Preserves the body byte-for-byte (only the YAML block changes).
 * - Preserves frontmatter keys that are not in the patch (e.g. user-defined
 *   `tags`, `category`, etc.).
 * - Patch values of `null` or `undefined` remove the key.
 * - Comments inside frontmatter are NOT preserved (YAML round-trip
 *   limitation; this is consistent with most md-frontmatter tools).
 */
export function applyFrontmatterPatch(raw: string, patch: Record<string, unknown>): string {
  const match = raw.match(FRONTMATTER_RE);
  let existing: Record<string, unknown> = {};
  let body = raw;
  if (match) {
    let parsed: unknown;
    try {
      parsed = yaml.load(match[1] ?? "");
    } catch {
      // Existing frontmatter unparseable; replace it whole rather than merge.
      parsed = {};
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
    body = raw.slice(match[0].length);
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }

  const yamlText = yaml.dump(merged, { lineWidth: -1, noRefs: true }).trimEnd();
  return `---\n${yamlText}\n---\n${body}`;
}

/**
 * Per-call options for {@link frontmatterToSkill} / {@link frontmatterToAgent}.
 *
 * `defaultOrigin` provides the origin URI used when the frontmatter doesn't
 * include `origin:`. Callers (install routes, fetchers) supply this so the
 * resulting `Skill.origin` is deterministic. If neither the frontmatter
 * nor `defaultOrigin` carries an origin, the parser synthesises
 * `file:<sourcePath>` so existing test fixtures and untagged local installs
 * still produce a valid `local/<name>` FQN.
 */
export interface ProjectionOpts {
  readonly defaultOrigin?: string;
}

/**
 * Build a {@link ProjectionOpts} from an optionally-undefined origin without
 * tripping `exactOptionalPropertyTypes`. Returns an empty object if `o` is
 * undefined so the field is genuinely omitted, not present-with-undefined.
 */
export function projectionOpts(o: string | undefined): ProjectionOpts {
  return o === undefined ? {} : { defaultOrigin: o };
}

interface CommonFields {
  shortName: string;
  scope: string;
  origin: string;
  description: string;
  version: string;
  dependencies?: {
    skills?: readonly DependencyRef[];
    mcps?: readonly DependencyRef[];
  };
}

function parseCommonFields(
  data: Record<string, unknown>,
  sourcePath: string,
  opts: ProjectionOpts,
): CommonFields {
  const { name, description, version, dependencies, origin, scope } = data;

  if (typeof name !== "string" || name.length === 0) {
    throw new FrontmatterError(sourcePath, "missing or non-string `name`");
  }
  // NameInvalid is a typed CatalogError — propagate it as-is so callers can
  // narrow on `instanceof NameInvalid`. Wrapping it in FrontmatterError would
  // erase the validation/parsing distinction the type hierarchy encodes.
  validateShortName(name);

  if (typeof description !== "string") {
    throw new FrontmatterError(sourcePath, "missing or non-string `description`");
  }
  if (version !== undefined && typeof version !== "string") {
    throw new FrontmatterError(sourcePath, "`version` must be a string when present");
  }

  const resolvedOrigin = resolveOrigin(origin, opts.defaultOrigin, sourcePath);

  let parsedOrigin: ParsedOrigin;
  try {
    parsedOrigin = parseOrigin(resolvedOrigin);
  } catch (cause) {
    if (cause instanceof OriginParseError) {
      throw new FrontmatterError(sourcePath, cause.message, { cause });
    }
    throw cause;
  }

  let resolvedScope: string;
  if (scope === undefined) {
    resolvedScope = scopeFromOrigin(parsedOrigin);
  } else if (typeof scope !== "string") {
    throw new FrontmatterError(sourcePath, "`scope` must be a string when present");
  } else {
    // Same rationale as validateShortName: let NameInvalid propagate.
    validateScope(scope);
    resolvedScope = scope;
  }

  return {
    shortName: name,
    scope: resolvedScope,
    origin: resolvedOrigin,
    description,
    version: (version as string) ?? "0.0.1",
    ...(dependencies !== undefined
      ? { dependencies: parseDependencies(dependencies, sourcePath) }
      : {}),
  };
}

function resolveOrigin(
  fromFrontmatter: unknown,
  defaultOrigin: string | undefined,
  sourcePath: string,
): string {
  if (fromFrontmatter !== undefined) {
    if (typeof fromFrontmatter !== "string" || fromFrontmatter.length === 0) {
      throw new FrontmatterError(sourcePath, "`origin` must be a non-empty string when present");
    }
    return fromFrontmatter;
  }
  if (defaultOrigin !== undefined) return defaultOrigin;
  return synthesizeOriginFromPath(sourcePath);
}

/**
 * Project frontmatter into a Skill, computing the FQN (`scope/name`) from
 * the resolved origin/scope per the post-#39 catalog identity rules.
 *
 * The frontmatter `name` field stays a short kebab-case identifier on
 * disk; the returned `Skill.name` is the full catalog identity (FQN).
 * Both forms are exposed so the runtime / dashboard can pick whichever
 * is appropriate for their context.
 */
export function frontmatterToSkill(
  data: Record<string, unknown>,
  sourcePath: string,
  opts: ProjectionOpts = {},
): Skill {
  const common = parseCommonFields(data, sourcePath, opts);
  const { prereqs } = data;

  if (prereqs !== undefined && typeof prereqs !== "string") {
    throw new FrontmatterError(sourcePath, "`prereqs` must be a string when present");
  }

  return {
    name: makeFqn(common.scope, common.shortName),
    shortName: common.shortName,
    scope: common.scope,
    origin: common.origin,
    description: common.description,
    version: common.version,
    ...(common.dependencies !== undefined ? { dependencies: common.dependencies } : {}),
    ...(prereqs !== undefined ? { prereqs: prereqs as string } : {}),
  };
}

/**
 * Project frontmatter into an Agent. See {@link frontmatterToSkill} —
 * agents share the same identity rules (short `name`, derived scope,
 * required origin with synthesis fallback).
 */
export function frontmatterToAgent(
  data: Record<string, unknown>,
  sourcePath: string,
  opts: ProjectionOpts = {},
): Agent {
  const common = parseCommonFields(data, sourcePath, opts);
  return {
    name: makeFqn(common.scope, common.shortName),
    shortName: common.shortName,
    scope: common.scope,
    origin: common.origin,
    description: common.description,
    version: common.version,
    ...(common.dependencies !== undefined ? { dependencies: common.dependencies } : {}),
  };
}

/**
 * Parse a frontmatter `dependencies` value into typed `DependencyRef` arrays.
 *
 * **Clean break (post-#39)**: legacy plain-string entries
 * (`dependencies.skills: ["foo"]`) are rejected with a
 * {@link FrontmatterError}. Every dep must be an object with `name` and
 * `origin`, optionally with `scope`. The `origin` field is required so the
 * recursive installer (`deepInstall`) can fetch missing deps without
 * additional metadata lookups.
 */
function parseDependencies(
  raw: unknown,
  sourcePath: string,
): { skills?: readonly DependencyRef[]; mcps?: readonly DependencyRef[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FrontmatterError(
      sourcePath,
      "`dependencies` must be a mapping with optional `skills` and `mcps` arrays",
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: { skills?: readonly DependencyRef[]; mcps?: readonly DependencyRef[] } = {};
  if (obj.skills !== undefined) {
    out.skills = parseDepRefArray(obj.skills, sourcePath, "dependencies.skills");
  }
  if (obj.mcps !== undefined) {
    out.mcps = parseDepRefArray(obj.mcps, sourcePath, "dependencies.mcps");
  }
  return out;
}

function parseDepRefArray(
  raw: unknown,
  sourcePath: string,
  field: string,
): readonly DependencyRef[] {
  if (!Array.isArray(raw)) {
    throw new FrontmatterError(
      sourcePath,
      `\`${field}\` must be an array of {name, origin, scope?} objects`,
    );
  }
  const out: DependencyRef[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item === "string") {
      throw new FrontmatterError(
        sourcePath,
        `\`${field}[${i}]\` must be a {name, origin, scope?} object — bare string deps are no longer supported (#39 clean break). Migrate to e.g. \`{name: "${item}", origin: "..."}\`.`,
      );
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new FrontmatterError(
        sourcePath,
        `\`${field}[${i}]\` must be a {name, origin, scope?} object`,
      );
    }
    const ref = item as Record<string, unknown>;
    const { name, origin, scope } = ref;
    if (typeof name !== "string" || name.length === 0) {
      throw new FrontmatterError(sourcePath, `\`${field}[${i}].name\` must be a non-empty string`);
    }
    if (typeof origin !== "string" || origin.length === 0) {
      throw new FrontmatterError(
        sourcePath,
        `\`${field}[${i}].origin\` is required and must be a non-empty string`,
      );
    }
    // Same rationale as parseCommonFields: let NameInvalid propagate.
    validateShortName(name);
    if (scope !== undefined) {
      if (typeof scope !== "string") {
        throw new FrontmatterError(
          sourcePath,
          `\`${field}[${i}].scope\` must be a string when present`,
        );
      }
      validateScope(scope);
    }
    out.push(scope === undefined ? { name, origin } : { name, origin, scope });
  }
  return out;
}

/**
 * Compute the FQN (`scope/name`) of a {@link DependencyRef}. Centralises
 * the (origin → scope) → fqn fallback chain so resolver/graph/manager all
 * agree on identity. Throws {@link FrontmatterError} if the ref's origin
 * is unparseable; callers wrap with their own context if needed.
 */
export function depRefToFqn(ref: DependencyRef): string {
  const scope = ref.scope ?? scopeFromOrigin(parseOrigin(ref.origin));
  return makeFqn(scope, ref.name);
}

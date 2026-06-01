import yaml from "js-yaml";
import type { OriginDeps } from "./dep-keys.js";

/**
 * Shared YAML-frontmatter parser used by `agent/agent-frontmatter.ts`
 * and `skill/skill-frontmatter.ts`. The frontmatter grammar is
 * identical across the two anchored kinds — the only per-kind
 * variations are:
 *
 *  - which `*FrontmatterError` class is thrown,
 *  - which anchor filename is named in the `missing frontmatter block`
 *    diagnostic (`AGENTS.md` vs `SKILL.md`),
 *  - which `validate{ShortName,Scope}` set is consulted for the
 *    name/scope rules (different example text + different error class).
 *
 * The factory returns the `parse` + `writeFrontmatter` codec pair that
 * each shadow re-exports.
 *
 * The codec is generic over the per-kind dep-key union `K` — e.g.
 * agent passes `"skills" | "mcps"`. A future per-kind divergence
 * (agent gains a `tools` dep) only adds to the calling shadow's
 * `depKeys`; this module stays untouched.
 *
 * Behavior note (F2-1): the agent-side legacy `{ origin: "…" }` object
 * form for `dependencies.<kind>[*]` is NOT supported here — only
 * string items are accepted, matching the skill-side behaviour. The
 * branch is dead in the marketplace (no first-party or marketplace
 * agent uses it); see the PR body for the disclosed behaviour change.
 */

/** A dep reference as it appears in the frontmatter wire shape: just an origin URI. */
export type AnchoredDependencyRef = string;

export interface AnchoredFrontmatter<K extends string> {
  readonly shortName: string;
  readonly scope: string;
  readonly description: string;
  readonly version: string;
  readonly prereqs?: string;
  /** Partial: any subset of `K` may be absent. */
  readonly dependencies?: Partial<Record<K, readonly AnchoredDependencyRef[]>>;
}

export interface ParsedAnchoredMd<K extends string> {
  readonly meta: AnchoredFrontmatter<K>;
  readonly body: string;
}

export interface FrontmatterCodec<K extends string> {
  parse(content: string, sourceLabel: string): ParsedAnchoredMd<K>;
  writeFrontmatter(content: string, meta: AnchoredFrontmatter<K>, sourceLabel: string): string;
}

/**
 * Per-kind name/scope validators consumed by the codec. Pulled from
 * `validate-shared.ts`'s `AnchoredValidators` to keep the shape free
 * of any error-class plumbing.
 */
export interface FrontmatterCodecValidators {
  readonly DEFAULT_SCOPE: string;
  validateShortName(name: unknown): asserts name is string;
  validateScope(scope: unknown): asserts scope is string;
}

export interface FrontmatterCodecConfig<K extends string> {
  /** Filename quoted in the `missing frontmatter block` message. */
  readonly anchorFilename: string;
  /** Per-kind error class used for every diagnostic thrown by this codec. */
  readonly ErrorClass: new (
    sourceLabel: string,
    reason: string,
    options?: { cause?: unknown },
  ) => Error;
  readonly validators: FrontmatterCodecValidators;
  /** The full dep-kind union recognised by this codec (e.g. `["skills", "mcps"]`). */
  readonly depKeys: readonly K[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)---\r?\n?/;

export function makeFrontmatterCodec<K extends string>(
  config: FrontmatterCodecConfig<K>,
): FrontmatterCodec<K> {
  const { anchorFilename, ErrorClass, depKeys } = config;
  // `asserts` calls require a directly-typed reference (lost on
  // destructuring), so keep the explicit cast through `config.validators`.
  const validators: FrontmatterCodecValidators = config.validators;
  const knownDepKeys = new Set<string>(depKeys);

  function parse(content: string, sourceLabel: string): ParsedAnchoredMd<K> {
    const match = content.match(FRONTMATTER_RE);
    if (!match) {
      throw new ErrorClass(
        sourceLabel,
        `missing frontmatter block (${anchorFilename} must start with \`---\` ... \`---\`)`,
      );
    }
    const yamlText = match[1] ?? "";
    const body = content.slice(match[0].length);

    let parsed: unknown;
    try {
      parsed = yaml.load(yamlText);
    } catch (cause) {
      throw new ErrorClass(sourceLabel, (cause as Error).message, { cause });
    }
    if (parsed === null || parsed === undefined) {
      throw new ErrorClass(sourceLabel, "frontmatter block is empty");
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ErrorClass(sourceLabel, "frontmatter must be a YAML mapping");
    }
    const data = parsed as Record<string, unknown>;
    const meta = projectFrontmatter(data, sourceLabel);
    return { meta, body };
  }

  function projectFrontmatter(
    data: Record<string, unknown>,
    sourceLabel: string,
  ): AnchoredFrontmatter<K> {
    const { name, scope, description, version, prereqs, dependencies } = data;

    if (typeof name !== "string" || name.length === 0) {
      throw new ErrorClass(sourceLabel, "missing or non-string `name`");
    }
    validators.validateShortName(name);

    const resolvedScope = scope === undefined ? validators.DEFAULT_SCOPE : scope;
    validators.validateScope(resolvedScope);

    if (typeof description !== "string") {
      throw new ErrorClass(sourceLabel, "missing or non-string `description`");
    }
    if (typeof version !== "string" || version.length === 0) {
      throw new ErrorClass(sourceLabel, "missing or empty `version`");
    }
    if (prereqs !== undefined && typeof prereqs !== "string") {
      throw new ErrorClass(sourceLabel, "`prereqs` must be a string when present");
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
  ): Partial<Record<K, readonly AnchoredDependencyRef[]>> | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new ErrorClass(sourceLabel, "`dependencies` must be a mapping");
    }
    const obj = raw as Record<string, unknown>;
    const out: Partial<Record<K, readonly AnchoredDependencyRef[]>> = {};
    for (const k of Object.keys(obj)) {
      if (!knownDepKeys.has(k)) continue;
      const items = obj[k];
      if (items === undefined) continue;
      out[k as K] = parseDependencyList(items, k, sourceLabel);
    }
    return out;
  }

  function parseDependencyList(
    raw: unknown,
    field: string,
    sourceLabel: string,
  ): AnchoredDependencyRef[] {
    if (!Array.isArray(raw)) {
      throw new ErrorClass(sourceLabel, `\`dependencies.${field}\` must be an array`);
    }
    return raw.map((item, idx) => {
      if (typeof item !== "string") {
        throw new ErrorClass(
          sourceLabel,
          `\`dependencies.${field}[${idx}]\` must be an origin URI string ` +
            '(e.g. "github:owner/repo/tree/main/skills/foo")',
        );
      }
      if (item.length === 0) {
        throw new ErrorClass(
          sourceLabel,
          `\`dependencies.${field}[${idx}]\` must be a non-empty origin URI`,
        );
      }
      return item;
    });
  }

  function writeFrontmatter(
    content: string,
    meta: AnchoredFrontmatter<K>,
    _sourceLabel: string,
  ): string {
    const match = content.match(FRONTMATTER_RE);
    const body = match ? content.slice(match[0].length) : content;
    const yamlText = serializeFrontmatter(meta);
    return `---\n${yamlText}---\n${body}`;
  }

  function serializeFrontmatter(meta: AnchoredFrontmatter<K>): string {
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

  return { parse, writeFrontmatter };
}

/**
 * Convenience: pull `meta.dependencies` into a dense `OriginDeps<K>`
 * with every dep-kind present (empty array when absent). Used by the
 * anchored-state builders.
 */
export function metaDepsToOriginDeps<K extends string>(
  depKeys: readonly K[],
  meta: AnchoredFrontmatter<K>,
): OriginDeps<K> {
  const out = {} as Record<K, readonly string[]>;
  for (const k of depKeys) {
    out[k] = meta.dependencies?.[k] ?? [];
  }
  return out;
}

import { SkillNameInvalidError } from "./errors.js";

/**
 * FQN / scope / short-name grammar for skills. Owned entirely by
 * `skill/` per the decoupling-over-abstraction axiom — agent mirrors
 * this file by intent. MCP has its own grammar (see `mcp/validate.ts`)
 * and correctly opts out — mcp names have no scope/short split, a
 * different length cap, and no kebab-case constraint.
 *
 * Grammar:
 *   - short name: lowercase kebab-case, max 64 chars, no `/`
 *   - scope:      lowercase kebab + reverse-DNS dots allowed, max 64
 *   - FQN:        `<scope>/<short>` exactly (single `/`)
 */

const MAX_SEGMENT_LEN = 64;
const SHORT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCOPE_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;

/** Default scope when frontmatter omits `scope:`. */
export const DEFAULT_SCOPE = "public";

/** Examples used in error messages. */
const SHORT_EXAMPLES: readonly [string, string] = ["tool-use", "web-search"];
const FQN_EXAMPLE = "public/tool-use";

/**
 * Validate a skill's short name (the kebab-case identifier authored
 * in `frontmatter.name`). Does NOT contain a `/` — scope is separate.
 */
export function validateShortName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new SkillNameInvalidError(String(name), "short name must be a non-empty string");
  }
  if (name.length > MAX_SEGMENT_LEN) {
    throw new SkillNameInvalidError(
      name,
      `short name must be at most ${MAX_SEGMENT_LEN} characters`,
    );
  }
  if (name.includes("/")) {
    throw new SkillNameInvalidError(
      name,
      "short name must not contain '/'; scope is configured separately via frontmatter",
    );
  }
  if (!SHORT_NAME.test(name)) {
    throw new SkillNameInvalidError(
      name,
      `short name must be lowercase kebab-case (e.g. '${SHORT_EXAMPLES[0]}', '${SHORT_EXAMPLES[1]}')`,
    );
  }
}

/** Validate a scope segment (kebab + reverse-DNS allowed). */
export function validateScope(scope: unknown): asserts scope is string {
  if (typeof scope !== "string" || scope.length === 0) {
    throw new SkillNameInvalidError(String(scope), "scope must be a non-empty string");
  }
  if (scope.length > MAX_SEGMENT_LEN) {
    throw new SkillNameInvalidError(scope, `scope must be at most ${MAX_SEGMENT_LEN} characters`);
  }
  if (!SCOPE_SEGMENT.test(scope)) {
    throw new SkillNameInvalidError(
      scope,
      "scope must be lowercase alphanumeric with single hyphens or dots (reverse-DNS allowed)",
    );
  }
}

/** Validate a fully-qualified skill name (`<scope>/<short>`). */
export function validateFqn(fqn: unknown): asserts fqn is string {
  if (typeof fqn !== "string" || fqn.length === 0) {
    throw new SkillNameInvalidError(String(fqn), "FQN must be a non-empty string");
  }
  const slashIdx = fqn.indexOf("/");
  if (slashIdx === -1) {
    throw new SkillNameInvalidError(
      fqn,
      `FQN must be of the form '<scope>/<short>' (e.g. '${FQN_EXAMPLE}')`,
    );
  }
  if (fqn.indexOf("/", slashIdx + 1) !== -1) {
    throw new SkillNameInvalidError(fqn, "FQN must contain exactly one '/'");
  }
  validateScope(fqn.slice(0, slashIdx));
  validateShortName(fqn.slice(slashIdx + 1));
}

/** Compose a validated FQN from its parts. */
export function makeFqn(scope: string, shortName: string): string {
  validateScope(scope);
  validateShortName(shortName);
  return `${scope}/${shortName}`;
}

/** Split a validated FQN into `{ scope, shortName }`. */
export function splitFqn(fqn: string): { scope: string; shortName: string } {
  validateFqn(fqn);
  const idx = fqn.indexOf("/");
  return { scope: fqn.slice(0, idx), shortName: fqn.slice(idx + 1) };
}

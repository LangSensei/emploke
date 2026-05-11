import { AgentNameInvalidError } from "./errors.js";

const MAX_SEGMENT_LEN = 64;
const SHORT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCOPE_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;

/** Default scope when frontmatter omits `scope:`. */
export const DEFAULT_SCOPE = "public";

/** Validate an agent's short name (the kebab-case identifier in `frontmatter.name`). */
export function validateShortName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new AgentNameInvalidError(String(name), "short name must be a non-empty string");
  }
  if (name.length > MAX_SEGMENT_LEN) {
    throw new AgentNameInvalidError(
      name,
      `short name must be at most ${MAX_SEGMENT_LEN} characters`,
    );
  }
  if (name.includes("/")) {
    throw new AgentNameInvalidError(
      name,
      "short name must not contain '/'; scope is configured separately via frontmatter",
    );
  }
  if (!SHORT_NAME.test(name)) {
    throw new AgentNameInvalidError(
      name,
      "short name must be lowercase kebab-case (e.g. 'researcher', 'web-builder')",
    );
  }
}

/** Validate a scope segment (kebab + reverse-DNS allowed). */
export function validateScope(scope: unknown): asserts scope is string {
  if (typeof scope !== "string" || scope.length === 0) {
    throw new AgentNameInvalidError(String(scope), "scope must be a non-empty string");
  }
  if (scope.length > MAX_SEGMENT_LEN) {
    throw new AgentNameInvalidError(scope, `scope must be at most ${MAX_SEGMENT_LEN} characters`);
  }
  if (!SCOPE_SEGMENT.test(scope)) {
    throw new AgentNameInvalidError(
      scope,
      "scope must be lowercase alphanumeric with single hyphens or dots (reverse-DNS allowed)",
    );
  }
}

/** Validate a fully-qualified agent name (`<scope>/<short>`). */
export function validateFqn(fqn: unknown): asserts fqn is string {
  if (typeof fqn !== "string" || fqn.length === 0) {
    throw new AgentNameInvalidError(String(fqn), "FQN must be a non-empty string");
  }
  const slashIdx = fqn.indexOf("/");
  if (slashIdx === -1) {
    throw new AgentNameInvalidError(
      fqn,
      "FQN must be of the form '<scope>/<short>' (e.g. 'public/researcher')",
    );
  }
  if (fqn.indexOf("/", slashIdx + 1) !== -1) {
    throw new AgentNameInvalidError(fqn, "FQN must contain exactly one '/'");
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

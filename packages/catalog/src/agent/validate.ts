import { type AnchoredValidators, makeValidators } from "../_shared/validate-shared.js";
import { AgentNameInvalidError } from "./errors.js";

/**
 * Per-kind name/scope/FQN validators for agents. Thin shadow over
 * `_shared/validate-shared.ts` — see that file for the grammar.
 * MCP names have a different grammar (see `mcp/validate.ts`).
 */
const validators: AnchoredValidators = makeValidators(AgentNameInvalidError, {
  short: ["researcher", "web-builder"],
  fqn: "public/researcher",
});

/** Default scope when frontmatter omits `scope:`. */
export const DEFAULT_SCOPE = validators.DEFAULT_SCOPE;

// `asserts` functions must be declared with explicit type annotations
// at every call site (TS2775); a bare `const v = factory.v` re-export
// loses the assertion signature, so the validators get re-declared
// here as function statements that delegate to the factory output.

/** Validate an agent's short name (the kebab-case identifier in `frontmatter.name`). */
export function validateShortName(name: unknown): asserts name is string {
  validators.validateShortName(name);
}

/** Validate a scope segment (kebab + reverse-DNS allowed). */
export function validateScope(scope: unknown): asserts scope is string {
  validators.validateScope(scope);
}

/** Validate a fully-qualified agent name (`<scope>/<short>`). */
export function validateFqn(fqn: unknown): asserts fqn is string {
  validators.validateFqn(fqn);
}

/** Compose a validated FQN from its parts. */
export function makeFqn(scope: string, shortName: string): string {
  return validators.makeFqn(scope, shortName);
}

/** Split a validated FQN into `{ scope, shortName }`. */
export function splitFqn(fqn: string): { scope: string; shortName: string } {
  return validators.splitFqn(fqn);
}

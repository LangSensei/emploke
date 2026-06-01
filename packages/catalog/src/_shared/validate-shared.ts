/**
 * Single source of truth for the `<scope>/<short>` validators shared
 * by `agent/validate.ts` and `skill/validate.ts`.
 *
 * Per-kind shadow files instantiate this factory with their own
 * `NameInvalidError` class + example names used in the human-readable
 * error messages. The grammar is identical across kinds — only the
 * error class identity and example text differ.
 *
 * Mcp does NOT use this factory: mcp names have a different grammar
 * (no scope/short split, different length cap, no kebab-case
 * constraint). See `mcp/validate.ts` for that distinct codec.
 */

const MAX_SEGMENT_LEN = 64;
const SHORT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCOPE_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;

/** Default scope when frontmatter omits `scope:`. */
export const DEFAULT_SCOPE = "public";

export interface ValidatorExamples {
  /** Two short-name examples used in the kebab-case violation message. */
  readonly short: readonly [string, string];
  /** One FQN example used in the missing-slash message. */
  readonly fqn: string;
}

export interface AnchoredValidators {
  readonly DEFAULT_SCOPE: string;
  validateShortName(name: unknown): asserts name is string;
  validateScope(scope: unknown): asserts scope is string;
  validateFqn(fqn: unknown): asserts fqn is string;
  makeFqn(scope: string, shortName: string): string;
  splitFqn(fqn: string): { scope: string; shortName: string };
}

/**
 * Returns the `validate*` / `makeFqn` / `splitFqn` set parameterised
 * by per-kind error class and example text. Each per-kind `validate.ts`
 * thin shadow calls this once and re-exports the result.
 */
export function makeValidators(
  ErrorClass: new (name: string, reason: string) => Error,
  examples: ValidatorExamples,
): AnchoredValidators {
  const kebabExample = `'${examples.short[0]}', '${examples.short[1]}'`;
  const fqnExample = examples.fqn;

  function validateShortName(name: unknown): asserts name is string {
    if (typeof name !== "string" || name.length === 0) {
      throw new ErrorClass(String(name), "short name must be a non-empty string");
    }
    if (name.length > MAX_SEGMENT_LEN) {
      throw new ErrorClass(name, `short name must be at most ${MAX_SEGMENT_LEN} characters`);
    }
    if (name.includes("/")) {
      throw new ErrorClass(
        name,
        "short name must not contain '/'; scope is configured separately via frontmatter",
      );
    }
    if (!SHORT_NAME.test(name)) {
      throw new ErrorClass(name, `short name must be lowercase kebab-case (e.g. ${kebabExample})`);
    }
  }

  function validateScope(scope: unknown): asserts scope is string {
    if (typeof scope !== "string" || scope.length === 0) {
      throw new ErrorClass(String(scope), "scope must be a non-empty string");
    }
    if (scope.length > MAX_SEGMENT_LEN) {
      throw new ErrorClass(scope, `scope must be at most ${MAX_SEGMENT_LEN} characters`);
    }
    if (!SCOPE_SEGMENT.test(scope)) {
      throw new ErrorClass(
        scope,
        "scope must be lowercase alphanumeric with single hyphens or dots (reverse-DNS allowed)",
      );
    }
  }

  function validateFqn(fqn: unknown): asserts fqn is string {
    if (typeof fqn !== "string" || fqn.length === 0) {
      throw new ErrorClass(String(fqn), "FQN must be a non-empty string");
    }
    const slashIdx = fqn.indexOf("/");
    if (slashIdx === -1) {
      throw new ErrorClass(fqn, `FQN must be of the form '<scope>/<short>' (e.g. '${fqnExample}')`);
    }
    if (fqn.indexOf("/", slashIdx + 1) !== -1) {
      throw new ErrorClass(fqn, "FQN must contain exactly one '/'");
    }
    validateScope(fqn.slice(0, slashIdx));
    validateShortName(fqn.slice(slashIdx + 1));
  }

  function makeFqn(scope: string, shortName: string): string {
    validateScope(scope);
    validateShortName(shortName);
    return `${scope}/${shortName}`;
  }

  function splitFqn(fqn: string): { scope: string; shortName: string } {
    validateFqn(fqn);
    const idx = fqn.indexOf("/");
    return { scope: fqn.slice(0, idx), shortName: fqn.slice(idx + 1) };
  }

  return {
    DEFAULT_SCOPE,
    validateShortName,
    validateScope,
    validateFqn,
    makeFqn,
    splitFqn,
  };
}

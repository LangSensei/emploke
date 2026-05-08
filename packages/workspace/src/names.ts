import { MAX_NAME_LENGTH } from "./constants.js";
import { WorkspaceNameInvalidError } from "./errors.js";

/**
 * Same kebab-case rule as `@emploke/catalog`: lowercase ascii letter to
 * start, then letters/digits/single hyphens. No scope / no slash — workspace
 * names live in the URL path as a single segment, so we reject anything
 * that would need encoding.
 */
const WORKSPACE_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Throw `WorkspaceNameInvalidError` unless `name` is a non-empty kebab-case
 * string of at most `MAX_NAME_LENGTH` characters. Used by both `init()` and
 * `WorkspaceRegistry.add()` so the constraint is enforced everywhere a name
 * enters the system.
 */
export function assertValidWorkspaceName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new WorkspaceNameInvalidError(String(name), "must be a non-empty string");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new WorkspaceNameInvalidError(name, `must be at most ${MAX_NAME_LENGTH} characters`);
  }
  if (!WORKSPACE_NAME_RE.test(name)) {
    throw new WorkspaceNameInvalidError(
      name,
      "must be kebab-case (lowercase letters, digits, single hyphens, starts with a letter)",
    );
  }
}

/** True iff `name` would pass `assertValidWorkspaceName`. Cheap predicate. */
export function isValidWorkspaceName(name: unknown): name is string {
  try {
    assertValidWorkspaceName(name);
    return true;
  } catch {
    return false;
  }
}

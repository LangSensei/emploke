import { NameInvalid } from "./errors.js";

/**
 * Validates a name (skill or agent). Supports:
 * - Unscoped: kebab-case (e.g. "security-audit")
 * - Scoped: scope/name (e.g. "langsensei/weather")
 *
 * Both scope and name segments must be kebab-case.
 */
const SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new NameInvalid(String(name), "must be a non-empty string");
  }
  if (name.length > 64) {
    throw new NameInvalid(name, "must be at most 64 characters");
  }
  const parts = name.split("/");
  if (parts.length === 1) {
    if (!SEGMENT.test(parts[0]!)) {
      throw new NameInvalid(name, "must be kebab-case (lowercase letters, digits, single hyphens, starts with a letter)");
    }
  } else if (parts.length === 2) {
    if (!SEGMENT.test(parts[0]!)) {
      throw new NameInvalid(name, `scope "${parts[0]}" must be kebab-case`);
    }
    if (!SEGMENT.test(parts[1]!)) {
      throw new NameInvalid(name, `name "${parts[1]}" must be kebab-case`);
    }
  } else {
    throw new NameInvalid(name, "must have at most one '/' separating scope from name");
  }
}

/**
 * Validates an MCP name. MCPs do not support scoped names.
 */
export function validateMcpName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new NameInvalid(String(name), "must be a non-empty string");
  }
  if (name.length > 64) {
    throw new NameInvalid(name, "must be at most 64 characters");
  }
  if (!SEGMENT.test(name)) {
    throw new NameInvalid(name, "must be kebab-case (MCP names do not support scopes)");
  }
}

/**
 * Convert a (possibly scoped) name to a relative directory path.
 * "langsensei/weather" → "langsensei/weather"
 * "weather" → "weather"
 */
export function nameToPath(name: string): string {
  return name; // scope/name maps directly to directory structure
}

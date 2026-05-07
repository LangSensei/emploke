import { NameInvalid } from "./errors.js";

/**
 * Validates a name (skill, agent, or MCP). Supports:
 * - Unscoped: kebab-case (e.g. "security-audit")
 * - Scoped: scope/name (e.g. "langsensei/weather", "io.playwright/mcp")
 *
 * Scope segments allow dots for reverse-DNS (e.g. io.playwright, com.example).
 * Name segments are kebab-case only.
 */
const NAME_SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCOPE_SEGMENT = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;

export function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new NameInvalid(String(name), "must be a non-empty string");
  }
  if (name.length > 64) {
    throw new NameInvalid(name, "must be at most 64 characters");
  }
  const parts = name.split("/");
  if (parts.length === 1) {
    if (!NAME_SEGMENT.test(parts[0]!)) {
      throw new NameInvalid(
        name,
        "must be kebab-case (lowercase letters, digits, single hyphens, starts with a letter)",
      );
    }
  } else if (parts.length === 2) {
    if (!SCOPE_SEGMENT.test(parts[0]!)) {
      throw new NameInvalid(
        name,
        `scope "${parts[0]}" must be lowercase alphanumeric with hyphens or dots`,
      );
    }
    if (!NAME_SEGMENT.test(parts[1]!)) {
      throw new NameInvalid(name, `name "${parts[1]}" must be kebab-case`);
    }
  } else {
    throw new NameInvalid(name, "must have at most one '/' separating scope from name");
  }
}

/**
 * Validates an MCP name. Now supports scoped names (including reverse-DNS scopes).
 */
export function validateMcpName(name: unknown): asserts name is string {
  validateName(name);
}

/**
 * Convert a (possibly scoped) name to a relative directory path.
 * "langsensei/weather" → "langsensei/weather"
 * "weather" → "weather"
 */
export function nameToPath(name: string): string {
  return name; // scope/name maps directly to directory structure
}

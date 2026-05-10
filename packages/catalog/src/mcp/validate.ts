import { McpNameInvalidError } from "./errors.js";

/**
 * Validate an MCP spec name. The grammar is fixed by the MCP spec,
 * not by emploke's storage layout — this function lives in the
 * service layer because "what counts as a valid MCP name" is a
 * business rule that any backend (FS, SQLite, in-memory) must enforce.
 *
 * Rules:
 *  - non-empty, ≤200 characters
 *  - no whitespace
 *  - no control characters or backslashes
 *  - exactly one `/` separating namespace from short name
 *  - both segments non-empty, neither equal to "." or ".."
 *
 * Throws {@link McpNameInvalidError} on violation.
 */
export function validateMcpName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new McpNameInvalidError(String(name), "must be a non-empty string");
  }
  if (name.length > 200) {
    throw new McpNameInvalidError(name, "must be at most 200 characters");
  }
  if (/\s/.test(name)) {
    throw new McpNameInvalidError(name, "must not contain whitespace");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
  if (/[\x00-\x1f\\]/.test(name)) {
    throw new McpNameInvalidError(name, "must not contain control characters or backslashes");
  }
  const slashIdx = name.indexOf("/");
  if (slashIdx === -1) {
    throw new McpNameInvalidError(
      name,
      "must contain exactly one '/' separating namespace from short name (e.g. 'azure/mcp')",
    );
  }
  if (name.indexOf("/", slashIdx + 1) !== -1) {
    throw new McpNameInvalidError(name, "must contain exactly one '/'");
  }
  const namespace = name.slice(0, slashIdx);
  const shortName = name.slice(slashIdx + 1);
  if (namespace.length === 0 || shortName.length === 0) {
    throw new McpNameInvalidError(name, "namespace and short name must both be non-empty");
  }
  for (const segment of [namespace, shortName]) {
    if (segment === "." || segment === "..") {
      throw new McpNameInvalidError(name, `'${segment}' is not allowed as a path segment`);
    }
  }
}

/**
 * Split a validated MCP name into its `{ namespace, shortName }` parts.
 * Caller MUST have already passed `validateMcpName(name)` — this
 * function does not re-validate.
 */
export function splitMcpName(name: string): { namespace: string; shortName: string } {
  const idx = name.indexOf("/");
  return { namespace: name.slice(0, idx), shortName: name.slice(idx + 1) };
}

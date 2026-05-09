import { McpNameInvalidError, NameInvalid } from "./errors.js";

/**
 * Name validation, split by role (#39 phase 1 — clean break).
 *
 * Three independent concepts the older `validateName` conflated:
 *
 *  - **short name** — what users write in a `SKILL.md` / `AGENTS.md`
 *    `name:` frontmatter field, what a `dependencies.skills[].name` carries,
 *    and what file-installed MCPs derive from their basename. Strict
 *    kebab-case, no `/`. The frontmatter `name` is never rewritten by the
 *    catalog, so it has to be authored to be portable across scopes.
 *
 *  - **scope** — an organisational namespace, derived by default from the
 *    install origin (`scopeFromOrigin`) but optionally overridable via a
 *    `scope:` frontmatter field. Allows reverse-DNS (`io.playwright`).
 *
 *  - **FQN** (fully-qualified name) — the catalog identity used for storage
 *    paths, in-memory map keys, dependency resolution, and uninstall
 *    safety. Always exactly `<scope>/<short>`, validated structurally.
 *
 * Why `name` may not contain `/`:
 *
 *  Empirically (verified via Copilot CLI experiments), the host loader
 *  silently rejects skills whose frontmatter `name` field contains `/`,
 *  `:`, or `@`. Forcing short names here moves that failure earlier in the
 *  pipeline with a clear error instead of a silent dropped skill at runtime.
 */
const NAME_SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCOPE_SEGMENT = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;
const MAX_SEGMENT_LEN = 64;

/**
 * Validate a SHORT name as authored in a frontmatter `name:` field or in a
 * dependency-ref `name:` field. Strict kebab-case; rejects `/` so the host
 * Copilot CLI loader cannot silently drop the entry.
 */
export function validateShortName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new NameInvalid(String(name), "must be a non-empty string");
  }
  if (name.length > MAX_SEGMENT_LEN) {
    throw new NameInvalid(name, `short name must be at most ${MAX_SEGMENT_LEN} characters`);
  }
  if (name.includes("/")) {
    throw new NameInvalid(
      name,
      "short name must not contain '/'; scope is configured separately (origin-derived or `scope:` field)",
    );
  }
  if (!NAME_SEGMENT.test(name)) {
    throw new NameInvalid(
      name,
      "short name must be kebab-case (lowercase letters, digits, single hyphens, starts with a letter)",
    );
  }
}

/**
 * Validate a scope segment. Allows reverse-DNS (`io.playwright`,
 * `com.example`) in addition to plain kebab-case. Lowercased input only.
 */
export function validateScope(scope: unknown): asserts scope is string {
  if (typeof scope !== "string" || scope.length === 0) {
    throw new NameInvalid(String(scope), "scope must be a non-empty string");
  }
  if (scope.length > MAX_SEGMENT_LEN) {
    throw new NameInvalid(scope, `scope must be at most ${MAX_SEGMENT_LEN} characters`);
  }
  if (!SCOPE_SEGMENT.test(scope)) {
    throw new NameInvalid(
      scope,
      "scope must be lowercase alphanumeric with single hyphens or dots (reverse-DNS allowed)",
    );
  }
}

/**
 * Validate a fully-qualified name (`scope/name`). Used at the catalog
 * boundary — every public method that takes a `name` parameter expects an
 * FQN string after #39. Throws on plain short names with a hint pointing at
 * the install endpoint that synthesises FQNs.
 */
export function validateFqn(fqn: unknown): asserts fqn is string {
  if (typeof fqn !== "string" || fqn.length === 0) {
    throw new NameInvalid(String(fqn), "FQN must be a non-empty string");
  }
  const slashIdx = fqn.indexOf("/");
  if (slashIdx === -1) {
    throw new NameInvalid(
      fqn,
      "FQN must be of the form '<scope>/<name>'; bare short names are not catalog identifiers (use the install endpoint, which synthesises the scope from origin)",
    );
  }
  if (fqn.indexOf("/", slashIdx + 1) !== -1) {
    throw new NameInvalid(fqn, "FQN must contain exactly one '/'");
  }
  const scope = fqn.slice(0, slashIdx);
  const name = fqn.slice(slashIdx + 1);
  validateScope(scope);
  validateShortName(name);
}

/**
 * Compose an FQN from its parts. Both halves are validated; the result is
 * guaranteed to round-trip through {@link validateFqn}.
 */
export function makeFqn(scope: string, shortName: string): string {
  validateScope(scope);
  validateShortName(shortName);
  return `${scope}/${shortName}`;
}

/**
 * Split a validated FQN into its components.
 */
export function splitFqn(fqn: string): { scope: string; name: string } {
  validateFqn(fqn);
  const idx = fqn.indexOf("/");
  return { scope: fqn.slice(0, idx), name: fqn.slice(idx + 1) };
}

/**
 * Convert a (scoped) FQN to a relative directory path. Returns the FQN
 * unchanged because catalog storage uses `<scope>/<name>` directories, but
 * kept as a function so future backends (SQLite, object store) can swap
 * the mapping without touching call sites.
 */
export function nameToPath(name: string): string {
  return name;
}

/**
 * Validate an MCP name per the MCP spec shape (`<namespace>/<short>`,
 * exactly one `/`, both halves non-empty, no whitespace, no path
 * traversal). Looser than {@link validateFqn} because the MCP spec
 * permits uppercase letters, dots and underscores (`io.github.User/my_server`)
 * and we trust publishers / community for global uniqueness rather than
 * enforce the spec regex.
 *
 * Filesystem path safety:
 *  - reject `..` segments so storage paths can't escape the mcps/ root
 *  - reject `\` (Windows path separator) and control chars
 *  - reject empty halves
 *
 * Throws {@link McpNameInvalidError} so the route layer maps it to 400.
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

/** Split a validated MCP spec name into its `{ namespace, shortName }` parts. */
export function splitMcpName(name: string): { namespace: string; shortName: string } {
  validateMcpName(name);
  const idx = name.indexOf("/");
  return { namespace: name.slice(0, idx), shortName: name.slice(idx + 1) };
}

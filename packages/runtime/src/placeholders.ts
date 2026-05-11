/**
 * Placeholder substitution for runtime-projected configuration strings.
 *
 * Marketplace-shareable MCP specs (and, in the future, agent / skill
 * frontmatter that reaches a runtime) cannot embed machine-specific
 * absolute paths and cannot rely on shell variable expansion (the MCP
 * spec at modelcontextprotocol.io has no `${VAR}` mechanism, and
 * wrapping commands in `bash -c "..."` so the shell does the expansion
 * breaks Windows immediately). This module provides emploke's own
 * placeholder grammar — a tiny, scheme-free `${name}` syntax with a
 * fixed vocabulary — so spec authors can write portable references
 * without leaking the host OS into their JSON.
 *
 * Vocabulary (intentionally small):
 *
 *   ${workspaceDir}   the absolute path of the workspace this
 *                     session/task lives under (`<workspaceDir>`,
 *                     parent of `<workspaceDir>/sessions/<id>/...`).
 *                     Pick this for state that should be PRIVATE to one
 *                     workspace — playwright cookies tied to one
 *                     project, repo-scoped credential caches.
 *
 *   ${globalDir}      a stable per-user directory (`<EMPLOKE_HOME>/shared`
 *                     by default). Pick this for state that should be
 *                     SHARED across all workspaces / sessions / tasks
 *                     on this machine — a single playwright login the
 *                     user wants every project to reuse, a global API
 *                     token cache.
 *
 * The two placeholders carve a clean scope axis (per-workspace vs
 * per-machine) without leaking emploke's product name into spec authors'
 * configs. The names mirror VS Code's `${workspaceFolder}` and the
 * universal `--global` / `--local` distinction npm/git use, so any
 * developer can read a spec and know which scope a path belongs to.
 *
 * **Why not more placeholders?**
 *  - `${userHome}` — encourages writing into the user's home root,
 *    which is bad citizenship and hard for the user to clean up later.
 *  - `${emplokeHome}` — that's emploke's own state directory (registry,
 *    logs); third-party MCPs writing here would mix concerns.
 *  - `${sessionDir}` / `${taskDir}` — per-invocation dirs are ephemeral
 *    (purged on session/task deletion). MCPs that want truly transient
 *    files can use the subprocess `cwd`, which is already the per-
 *    session workdir — relative paths handle that case without a
 *    placeholder.
 *
 * Substitution is purely lexical: `${workspaceDir}` is replaced
 * verbatim wherever it appears in a string, anywhere. There is no
 * conditional, no fallback, no `${var:-default}` shell-style syntax.
 * If a placeholder name isn't recognised, {@link substitutePlaceholders}
 * throws {@link UnknownPlaceholderError} so a typo surfaces at install
 * time instead of producing a literal `${typo}` path that some downstream
 * tool then opens against `cwd`.
 *
 * Paths produced by substitution are always returned with FORWARD
 * slashes, even on Windows — Node's `fs` accepts `C:/Users/...` natively
 * and shipping forward-slash paths in JSON keeps marketplace specs
 * visually identical across platforms (no `\\` escaping).
 */

// Loose match `${...}` so any name we DON'T recognise still surfaces as
// {@link UnknownPlaceholderError} instead of silently passing through.
// Strict validation happens in {@link substitutePlaceholders}: only
// {@link PLACEHOLDER_NAMES} resolve; everything else throws. The
// rationale is "fail loud on a typo" — a stray `${workspceDir}` in a
// spec would otherwise expand to a literal `${workspceDir}` substring
// that downstream MCP servers would dutifully open against `cwd`,
// producing inscrutable runtime errors instead of a clear install-time
// rejection.
const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

/** Names of supported placeholders, public so callers can validate / autocomplete. */
export const PLACEHOLDER_NAMES = ["workspaceDir", "globalDir"] as const;
export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

/**
 * Resolution context for {@link substitutePlaceholders}. Both fields
 * are required absolute paths; the substituter does not fall back to
 * any default — providing the values is the caller's responsibility
 * (server bootstrap derives them from `EMPLOKE_HOME` and the active
 * workspace's `workdir`).
 */
export interface PlaceholderContext {
  readonly workspaceDir: string;
  readonly globalDir: string;
}

export class UnknownPlaceholderError extends Error {
  override readonly name = "UnknownPlaceholderError";
  constructor(
    readonly placeholder: string,
    readonly source: string,
  ) {
    super(
      `unknown placeholder \${${placeholder}} in ${source}; ` +
        `supported: ${PLACEHOLDER_NAMES.map((n) => `\${${n}}`).join(", ")}`,
    );
  }
}

/**
 * Replace every `${name}` occurrence in `input` with the matching value
 * from `ctx`. `source` is a human-readable label (e.g. an MCP name)
 * used only in error messages so a typo points back at the offending
 * spec.
 *
 * Substituted paths are normalised to forward slashes regardless of
 * host OS — see file-level docstring for rationale.
 */
export function substitutePlaceholders(
  input: string,
  ctx: PlaceholderContext,
  source: string,
): string {
  return input.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (name === "workspaceDir") return toForwardSlash(ctx.workspaceDir);
    if (name === "globalDir") return toForwardSlash(ctx.globalDir);
    throw new UnknownPlaceholderError(name, source);
  });
}

/**
 * Recursively walk a JSON-shaped value, applying
 * {@link substitutePlaceholders} to every string leaf. Non-string leaves
 * (numbers, booleans, null) are returned unchanged. Arrays and plain
 * objects are reconstructed with substituted contents.
 *
 * Used to project an MCP server config so `args`, `env` values, and
 * any nested string field carry resolved paths instead of placeholders.
 */
export function substitutePlaceholdersDeep<T>(
  value: T,
  ctx: PlaceholderContext,
  source: string,
): T {
  if (typeof value === "string") {
    return substitutePlaceholders(value, ctx, source) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitutePlaceholdersDeep(v, ctx, source)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitutePlaceholdersDeep(v, ctx, source);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Normalise a filesystem path to forward slashes. Windows tolerates
 * forward slashes in `node:fs` calls, in `child_process.spawn` arg
 * strings (programs receive what we pass; very few are picky about
 * separator), and in playwright/most MCP servers' file-handling code.
 * Forward-slash paths also keep marketplace JSON visually clean (no
 * doubled `\\\\`) and bytewise identical across hosts.
 */
function toForwardSlash(p: string): string {
  return p.replaceAll("\\", "/");
}

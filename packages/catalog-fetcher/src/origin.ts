import { OriginParseError } from "./errors.js";

/**
 * Parsed shape of a Phase-1 origin URI. Two schemes:
 *
 * - `github` — a GitHub browser URL of the form
 *   `https://github.com/<owner>/<repo>/tree/<ref>/<path?>` (path optional;
 *   absent path means the entry sits at repo root). The `cloneUrl` is the
 *   matching `https://github.com/<owner>/<repo>.git` for `git clone`.
 *
 * - `file` — a `file:<absolutePath>` URI pointing at a local directory. Used
 *   when installing from a local source dir; auto-injected by the local
 *   install routes when frontmatter omits `origin`.
 *
 * Phase 1 deliberately omits `npm:` and generic `git+ssh://` — they are
 * deferred to Phase 2 to keep this PR focused.
 */
export type ParsedOrigin =
  | {
      readonly scheme: "github";
      readonly owner: string;
      readonly repo: string;
      readonly ref: string;
      readonly path: string | null;
      readonly cloneUrl: string;
      readonly raw: string;
    }
  | {
      readonly scheme: "file";
      readonly path: string;
      readonly raw: string;
    };

const GITHUB_TREE_RE =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/tree\/([^/\s]+)(?:\/(.+))?\/?$/;

/**
 * Parse a Phase-1 origin URI. Throws {@link OriginParseError} on any input
 * that doesn't match a supported scheme. The caller is expected to have
 * already trimmed surrounding whitespace.
 *
 * Examples:
 *  - `https://github.com/anthropic/skills/tree/main/tool-use`
 *      → { scheme: "github", owner, repo, ref: "main", path: "tool-use", … }
 *  - `https://github.com/foo/bar/tree/main`
 *      → { …, path: null }
 *  - `file:/abs/path` or `file:C:/abs/path` (Windows)
 *      → { scheme: "file", path }
 *
 * Bare repo URLs (no `/tree/<ref>`) are explicitly rejected: refusing here
 * avoids a network round-trip to discover the default branch and forces the
 * user to commit to a specific ref so installs are reproducible.
 */
export function parseOrigin(uri: string): ParsedOrigin {
  if (typeof uri !== "string" || uri.length === 0) {
    throw new OriginParseError(String(uri), "must be a non-empty string");
  }

  if (uri.startsWith("file:")) {
    const rest = uri.slice("file:".length);
    if (rest.length === 0) {
      throw new OriginParseError(uri, "file: URI requires a path (e.g. file:/abs/path)");
    }
    return { scheme: "file", path: rest, raw: uri };
  }

  if (uri.startsWith("https://github.com/")) {
    const m = uri.match(GITHUB_TREE_RE);
    if (!m) {
      throw new OriginParseError(
        uri,
        "GitHub URL must be of the form https://github.com/<owner>/<repo>/tree/<ref>[/path]",
      );
    }
    const [, owner, repo, ref, path] = m;
    return {
      scheme: "github",
      owner: owner!,
      repo: repo!,
      ref: ref!,
      path: path && path.length > 0 ? path.replace(/\/+$/, "") : null,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      raw: uri,
    };
  }

  throw new OriginParseError(
    uri,
    "unsupported scheme; Phase 1 supports only https://github.com/.../tree/<ref>/[path] and file:<path>",
  );
}

/**
 * Canonical string form for storage / equality comparison. Two origins are
 * "the same" iff their {@link normalizeOrigin} outputs match. Used by the
 * origin-conflict detector to decide whether an install is a re-install
 * (same origin, idempotent skip) vs a true conflict (different origin).
 *
 * Normalisation rules:
 *  - `github`: case-fold owner+repo, drop trailing slash, drop optional
 *    `.git` suffix (already stripped by the parser).
 *  - `file`: pass through. Callers that care about path canonicalisation
 *    (resolving symlinks, normalising case on Windows) should do that
 *    before calling parseOrigin.
 */
export function normalizeOrigin(origin: ParsedOrigin): string {
  switch (origin.scheme) {
    case "github": {
      const o = origin.owner.toLowerCase();
      const r = origin.repo.toLowerCase();
      const path = origin.path ? `/${origin.path}` : "";
      return `https://github.com/${o}/${r}/tree/${origin.ref}${path}`;
    }
    case "file":
      return `file:${origin.path}`;
  }
}

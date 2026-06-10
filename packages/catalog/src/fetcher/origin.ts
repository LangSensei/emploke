import { OriginParseError } from "./errors.js";

/**
 * Parsed shape of an origin URI. Three schemes are supported:
 *
 * - `github` — a GitHub browser URL of the form
 *   `https://github.com/<owner>/<repo>/tree/<ref>/<path?>` (path optional;
 *   absent path means the entry sits at repo root). The `cloneUrl` is the
 *   matching `https://github.com/<owner>/<repo>.git` for `git clone`.
 *
 * - `azure-devops` — an Azure DevOps Services URL of the form
 *   `https://dev.azure.com/<org>/<project>/_git/<repo>?path=/<path>`. Unlike
 *   `github`, the catalog deliberately does NOT accept a ref pin (`&version=`)
 *   here: ADO's GB/GT/GC ref-prefix grammar differs from git and is not yet
 *   modelled. The install always reads the repo's default branch. Legacy
 *   `<org>.visualstudio.com` and on-prem TFS hosts (`tfs.<x>.com` or any
 *   URL whose path starts with `/tfs/`) are rejected at parse time with
 *   an actionable message.
 *
 * - `file` — a `file:<absolutePath>` URI pointing at a local directory. Used
 *   when installing from a local source dir; auto-injected by the local
 *   install routes when frontmatter omits `origin`.
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
      readonly scheme: "azure-devops";
      readonly org: string;
      readonly project: string;
      readonly repo: string;
      readonly path: string;
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
 * Cross-platform absolute-path detection. Accepts:
 *  - POSIX:    `/usr/local/...`
 *  - Windows:  `C:/...`, `C:\...`, `\\server\share\...`
 *
 * Rejects: `./foo`, `../foo`, bare `foo`, `~/foo`.
 */
function isAbsolutePath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith("/")) return true;
  if (p.startsWith("\\\\")) return true; // Windows UNC
  // Windows drive: `C:/...` or `C:\...`. Case-insensitive single letter.
  if (p.length >= 3 && /^[a-zA-Z]:[\\/]/.test(p)) return true;
  return false;
}

/**
 * Parse an origin URI. Throws {@link OriginParseError} on any input
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
    // Normalise: accept `file:/abs`, `file:///abs`, and `file:C:/...` /
    // `file:///C:/...` shapes; strip the leading double-slash if present,
    // and also strip a single leading `/` when followed by a Windows
    // drive letter (RFC 8089 says `file:///C:/...` so the path part is
    // `/C:/...` which we want to coerce to `C:/...` for native `node:fs`).
    let stripped = rest.startsWith("//") ? rest.slice(2) : rest;
    if (/^\/[a-zA-Z]:[\\/]/.test(stripped)) stripped = stripped.slice(1);
    if (!isAbsolutePath(stripped)) {
      throw new OriginParseError(
        uri,
        "file: URI must be an absolute path " +
          '(e.g. "file:/Users/me/skills/x" or "file:///C:/Users/me/skills/x"). ' +
          "Relative paths are intentionally rejected so origins are stable across cwd.",
      );
    }
    return { scheme: "file", path: stripped, raw: uri };
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

  // Legacy Azure DevOps hostname — reject with a pointer to the
  // dev.azure.com equivalent. Checked before the dev.azure.com branch
  // so the user gets a specific message instead of "unsupported scheme".
  if (/^https:\/\/[^/]+\.visualstudio\.com\//i.test(uri)) {
    throw new OriginParseError(
      uri,
      "{org}.visualstudio.com is the legacy Azure DevOps host; " +
        "use the equivalent https://dev.azure.com/{org}/{project}/_git/{repo}?path=/... form",
    );
  }

  // On-prem Azure DevOps Server / TFS — different auth + API surface,
  // not in scope for this fetcher. Match both `tfs.<x>.com` hostnames
  // and any `/tfs/` collection-path style URL.
  if (/^https:\/\/(tfs\.[^/]+|[^/]+\/tfs\/)/i.test(uri)) {
    throw new OriginParseError(
      uri,
      "on-prem Azure DevOps Server / TFS (tfs.*/... or */tfs/...) is not supported; " +
        "only Azure DevOps Services (https://dev.azure.com/) is supported",
    );
  }

  if (uri.startsWith("https://dev.azure.com/")) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new OriginParseError(uri, "malformed dev.azure.com URL");
    }
    // ADO's ref-pinning grammar (`&version=GBmain`, `&version=GTtag1.0`,
    // `&version=GCsha`) doesn't map cleanly onto git refs and the catalog
    // does not yet model the prefix → ref kind dispatch. Rejecting here
    // rather than silently dropping the ref preserves install-from-default-
    // branch semantics and avoids surprising the user with a divergent ref.
    if (parsed.searchParams.has("version")) {
      throw new OriginParseError(
        uri,
        "&version= is not supported on dev.azure.com URLs: " +
          "ADO's ref-pinning prefixes (GB branch / GT tag / GC commit) differ from git refs " +
          "and are not yet modelled. Omit &version= to install from the repo's default branch.",
      );
    }
    const segs = parsed.pathname.split("/");
    const shapeOk =
      (segs.length === 5 || (segs.length === 6 && segs[5] === "")) &&
      segs[1] !== "" &&
      segs[2] !== "" &&
      segs[3] === "_git" &&
      segs[4] !== "";
    if (!shapeOk) {
      throw new OriginParseError(
        uri,
        "dev.azure.com URL must be of the form " +
          "https://dev.azure.com/{org}/{project}/_git/{repo}?path=/...",
      );
    }
    const org = decodeURIComponent(segs[1]!);
    const project = decodeURIComponent(segs[2]!);
    const repo = decodeURIComponent(segs[4]!);

    const rawPath = parsed.searchParams.get("path");
    if (rawPath === null || rawPath === "") {
      throw new OriginParseError(
        uri,
        "dev.azure.com URL requires a ?path=/... query parameter naming the file or directory to install",
      );
    }
    let normPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    normPath = normPath.replace(/\/+$/, "");
    if (normPath === "") {
      throw new OriginParseError(
        uri,
        "dev.azure.com ?path= must not be empty after stripping trailing slashes",
      );
    }
    return {
      scheme: "azure-devops",
      org,
      project,
      repo,
      path: normPath,
      raw: uri,
    };
  }

  throw new OriginParseError(
    uri,
    "unsupported scheme; supported schemes are " +
      "https://github.com/<owner>/<repo>/tree/<ref>[/path], " +
      "https://dev.azure.com/<org>/<project>/_git/<repo>?path=/..., " +
      "and file:<absolutePath>",
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
 *  - `azure-devops`: re-encode `project` and `path` so the canonical
 *    string is stable across equivalent input encodings. `org` and `repo`
 *    are NOT case-folded — Azure DevOps treats both as case-sensitive
 *    identifiers, unlike GitHub.
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
    case "azure-devops": {
      const encProject = encodeURIComponent(origin.project);
      // Encode each path segment so spaces / non-ASCII characters survive
      // round-tripping, but keep `/` separators visible (don't collapse
      // the whole path into a single encoded blob — the catalog URL is
      // also a user-facing string).
      const encPath = origin.path
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      return `https://dev.azure.com/${origin.org}/${encProject}/_git/${origin.repo}?path=${encPath}`;
    }
    case "file":
      // Canonical file URI form: `file:///<path>`. Both the parser
      // and existing storage may have stripped the leading `//`, so
      // re-add when normalising for cross-platform equality.
      return `file:///${origin.path.replace(/^\/+/, "")}`;
  }
}

/**
 * Returns true iff `a` and `b` are equivalent after origin
 * normalisation. Pure: throws nothing, falls back to byte-equality
 * when either input fails to parse (defensive for unmigrated callers
 * that may pass a malformed origin string).
 *
 * This is the canonical origin-equality predicate; callers in
 * `agent/agent-service.ts`, `skill/skill-service.ts`, and
 * `mcp/mcp-service.ts` import it from `fetcher/index.js`. The fetcher
 * module owns origin grammar, so the equality check lives here.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return normalizeOrigin(parseOrigin(a)) === normalizeOrigin(parseOrigin(b));
  } catch {
    return a === b;
  }
}

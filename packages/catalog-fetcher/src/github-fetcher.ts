import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";
import { FetchError } from "./errors.js";
import type { EntryFile, Fetcher } from "./fetcher.js";
import { resolveDefaultGitHubToken } from "./gh-token.js";
import { parseOrigin } from "./origin.js";

/**
 * Fetcher for `https://github.com/<owner>/<repo>/tree/<ref>[/path]` URIs.
 *
 * Three transports, picked by call-site + origin shape:
 *
 *  - {@link GitHubFetcher.fetchFile} — single-file reads use the
 *    **Contents API** (`/repos/{o}/{r}/contents/{path}?ref={ref}`)
 *    with `Accept: application/vnd.github.raw` so the body is the
 *    raw file bytes, not a base64-wrapped JSON envelope. One small
 *    request, no tarball, no extraction. The resolve path goes here
 *    — anchor files (SKILL.md / AGENTS.md / `<name>.json`) only.
 *
 *  - {@link GitHubFetcher.fetchTree} on a **subpath** origin uses
 *    the **Git Trees API** (`/repos/{o}/{r}/git/trees/{ref}?recursive=1`)
 *    to list every blob in the repo by `(path, sha)` once, filters
 *    to entries under the subpath, then fans out parallel
 *    {@link fetchBlobRaw} requests against the **Git Blobs API**
 *    (`/repos/{o}/{r}/git/blobs/{sha}` with `Accept: application/vnd.github.raw`).
 *    Cost: 1 small JSON RTT + N blob RTTs in parallel — orders of
 *    magnitude less wire than downloading the whole repo tarball
 *    when the subpath is a small fraction of the tree.
 *
 *  - {@link GitHubFetcher.fetchTree} on a **whole-repo** origin
 *    (no subpath) or when the tree listing is **truncated** falls
 *    back to the **Tarball API** (`/repos/{o}/{r}/tarball/{ref}`),
 *    gunzip + tar-extract on the fly. The Trees API caps recursive
 *    listings at 100K entries / ~7MB; bigger repos return
 *    `truncated: true` and we can't trust a partial list. For a
 *    whole-repo install the tarball is also cheaper than N parallel
 *    blob requests (one streaming HTTPS download wins on RTT count).
 *
 * **Auth**: optional. The token is resolved via {@link resolveDefaultGitHubToken}
 * which checks `GITHUB_TOKEN` / `GH_TOKEN` env vars first and then falls
 * back to `gh auth token --hostname github.com` (cached per-host for 60s).
 * If a token is available we attach `Authorization: Bearer <token>` so
 * private repos work and the rate limit goes from 60/h to 5000/h. Anonymous
 * requests work fine for public repos in practice.
 *
 * **Tarball shape**: GitHub wraps the entire tree in a single top-level
 * directory like `<owner>-<repo>-<sha7>/`. We auto-detect that prefix
 * from the first entry and strip it. If the origin specifies a subpath,
 * we additionally filter to entries under that subpath and strip it
 * (so `tree/main/skills/x` yields entries relative to `x/`, not
 * `skills/x/`).
 *
 * **50 MB per-file cap**: enforced for any individual blob — sufficient
 * for any sane skill / agent / mcp.
 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Bound on concurrent Blobs API requests per `fetchTree` call. GitHub's
 * authenticated rate limit is 5000/h and there's no per-second throttle
 * documented for these endpoints, but bounded fan-out keeps tail
 * latency tight on small skills (~5-30 files: 1-4 batches) and avoids
 * any pathological burst behaviour for pathologically large subtrees.
 */
const TREE_BLOB_PARALLELISM = 8;

export class GitHubFetcher implements Fetcher {
  readonly scheme = "github";

  async fetchFile(uri: string, relPath: string): Promise<Buffer> {
    const origin = parseOrigin(uri);
    if (origin.scheme !== "github") {
      throw new FetchError(uri, "GitHubFetcher only handles github URIs");
    }
    if (typeof relPath !== "string") {
      throw new FetchError(uri, "fetchFile relPath must be a string");
    }
    if (relPath.startsWith("/")) {
      throw new FetchError(uri, `fetchFile relPath must be relative, got "${relPath}"`);
    }
    const { owner, repo, ref, path: subPath } = origin;

    // Compose the target path:
    //  - relPath === "" → origin already names the file (mcp single-file
    //    case); use subPath as-is. Reject if subPath is null (no file
    //    to read).
    //  - relPath !== "" → join subPath (if any) + relPath. Strip leading
    //    slashes from each segment to keep the URL clean.
    let targetPath: string;
    if (relPath === "") {
      if (subPath === null) {
        throw new FetchError(
          uri,
          "fetchFile with empty relPath requires the origin to point at a file (no subpath given)",
        );
      }
      targetPath = stripLeadingSlash(subPath);
    } else {
      const cleanRel = stripLeadingSlash(relPath);
      targetPath = subPath ? `${stripTrailingSlash(subPath)}/${cleanRel}` : cleanRel;
    }
    // Encode each segment so spaces / Unicode survive transport, but
    // keep the slash separators. Empty path (root) is rejected above.
    const encodedPath = targetPath
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;

    const headers = await this.buildHeaders("application/vnd.github.raw");

    let response: Response;
    try {
      response = await fetch(contentsUrl, { headers, redirect: "follow" });
    } catch (cause) {
      throw new FetchError(uri, `network error fetching contents: ${(cause as Error).message}`, {
        cause,
      });
    }
    if (!response.ok) {
      // Drain body so we don't keep the socket open. Status text is
      // safe to surface (no token leakage); response body is NOT
      // surfaced because GitHub's error JSON sometimes echoes the
      // request including the Authorization header in non-200 paths.
      try {
        await response.text();
      } catch {}
      throw new FetchError(
        uri,
        `GitHub Contents API returned ${response.status} ${response.statusText} for ${targetPath}`,
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) {
      throw new FetchError(uri, `file exceeds ${MAX_FILE_BYTES}-byte cap`);
    }
    return buf;
  }

  async *fetchTree(uri: string): AsyncIterable<EntryFile> {
    const origin = parseOrigin(uri);
    if (origin.scheme !== "github") {
      throw new FetchError(uri, "GitHubFetcher only handles github URIs");
    }
    const { owner, repo, ref, path: subPath } = origin;

    // Whole-repo install: the tarball is a single streaming HTTPS
    // download vs N parallel round-trips for every blob. Skip the
    // Trees+Blobs path entirely.
    if (subPath === null) {
      yield* this.fetchTreeViaTarball(uri, owner, repo, ref, null);
      return;
    }

    // Subpath install: try the Trees+Blobs path first. The Trees API
    // returns the full repo's `(path, sha)` listing in one call; we
    // filter to the subpath and fan out parallel Blobs requests for
    // just those files. Falls back to tarball if the tree listing is
    // truncated (GitHub caps recursive=1 at 100K entries / ~7MB).
    const tree = await this.fetchTreeListing(uri, owner, repo, ref);
    if (tree === null) {
      yield* this.fetchTreeViaTarball(uri, owner, repo, ref, subPath);
      return;
    }

    yield* this.fetchTreeViaBlobs(uri, owner, repo, subPath, tree);
  }

  /**
   * List every blob in the repo at `ref` via the Git Trees API
   * (`recursive=1`). Returns the blob entries on success, or `null`
   * when GitHub marks the listing `truncated: true` (caller should
   * fall back to a different transport — typically tarball).
   *
   * Network / auth / "ref not found" errors throw {@link FetchError}
   * instead of returning null: those failures aren't tarball-specific
   * and the tarball would fail with the same root cause but a less
   * specific message.
   */
  private async fetchTreeListing(
    uri: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<TreeBlobEntry[] | null> {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const headers = await this.buildHeaders("application/vnd.github+json");

    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "follow" });
    } catch (cause) {
      throw new FetchError(uri, `network error fetching tree: ${(cause as Error).message}`, {
        cause,
      });
    }
    if (!response.ok) {
      try {
        await response.text();
      } catch {}
      throw new FetchError(
        uri,
        `GitHub Trees API returned ${response.status} ${response.statusText}`,
      );
    }
    let json: TreeListingResponse;
    try {
      json = (await response.json()) as TreeListingResponse;
    } catch (cause) {
      throw new FetchError(
        uri,
        `Trees API response was not valid JSON: ${(cause as Error).message}`,
        {
          cause,
        },
      );
    }
    if (json.truncated === true) return null;
    if (!Array.isArray(json.tree)) {
      throw new FetchError(uri, "Trees API response missing `tree` array");
    }
    const blobs: TreeBlobEntry[] = [];
    for (const entry of json.tree) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        entry.type === "blob" &&
        typeof entry.path === "string" &&
        typeof entry.sha === "string"
      ) {
        blobs.push({ path: entry.path, sha: entry.sha });
      }
    }
    return blobs;
  }

  /**
   * Fan out parallel Blobs API requests for every entry in `tree` that
   * falls under `subPath`, yielding `EntryFile` records. Subpath
   * matching mirrors the tarball implementation:
   *
   *  - subPath points at a directory → strip `subPath/` prefix from
   *    `path` to get `relPath`.
   *  - subPath points at a file (the only blob whose path equals
   *    subPath exactly) → yield as basename. Mirrors the
   *    "single-file subpath" tarball branch so callers see the same
   *    `relPath` regardless of which transport ran.
   *
   * Throws {@link FetchError} when the subpath matched zero blobs
   * (subpath doesn't exist in the tree).
   *
   * Yield order is the tree-listing order (filtered, then parallel-
   * fetched, then collected). Consumers like `AgentService.install`
   * slurp into a `Map`, so order doesn't affect correctness.
   */
  private async *fetchTreeViaBlobs(
    uri: string,
    owner: string,
    repo: string,
    subPath: string,
    tree: TreeBlobEntry[],
  ): AsyncIterable<EntryFile> {
    const subPrefix = subPath.replace(/\/+$/, "");
    const planned: { sha: string; relPath: string }[] = [];
    for (const blob of tree) {
      if (blob.path === subPrefix) {
        // Single-file subpath: yield as basename so consumers can
        // identify the file (matches the tarball's single-file branch).
        const slashIdx = subPrefix.lastIndexOf("/");
        const basename = slashIdx >= 0 ? subPrefix.slice(slashIdx + 1) : subPrefix;
        planned.push({ sha: blob.sha, relPath: basename });
      } else if (blob.path.startsWith(`${subPrefix}/`)) {
        planned.push({ sha: blob.sha, relPath: blob.path.slice(subPrefix.length + 1) });
      }
    }
    if (planned.length === 0) {
      throw new FetchError(uri, `subpath "${subPath}" matched no blobs in the tree`);
    }

    // Bounded worker pool. We intentionally collect everything before
    // yielding (rather than streaming as each blob completes) for two
    // reasons:
    //   1. Yield order is stable (matches the tree listing order).
    //   2. Errors short-circuit cleanly — a single rejection aborts
    //      the wait without leaving in-flight requests dangling
    //      uncaught.
    const results: EntryFile[] = new Array(planned.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= planned.length) return;
        const job = planned[i];
        if (job === undefined) return;
        const content = await this.fetchBlobRaw(uri, owner, repo, job.sha);
        results[i] = { relPath: job.relPath, content };
      }
    };
    const workerCount = Math.min(TREE_BLOB_PARALLELISM, planned.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);

    for (const file of results) yield file;
  }

  /**
   * Fetch a single blob's raw bytes via the Git Blobs API. Uses
   * `Accept: application/vnd.github.raw` so the response body is the
   * file's raw bytes (not a base64-wrapped JSON envelope). Same
   * leak-guard pattern as {@link fetchFile}: the response body is
   * never surfaced in the error message.
   */
  private async fetchBlobRaw(
    uri: string,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<Buffer> {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`;
    const headers = await this.buildHeaders("application/vnd.github.raw");

    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "follow" });
    } catch (cause) {
      throw new FetchError(uri, `network error fetching blob ${sha}: ${(cause as Error).message}`, {
        cause,
      });
    }
    if (!response.ok) {
      try {
        await response.text();
      } catch {}
      throw new FetchError(
        uri,
        `GitHub Blobs API returned ${response.status} ${response.statusText} for blob ${sha}`,
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) {
      throw new FetchError(uri, `blob ${sha} exceeds ${MAX_FILE_BYTES}-byte cap`);
    }
    return buf;
  }

  /**
   * Build the standard request headers used across all GitHub API
   * endpoints touched by this fetcher: User-Agent (required by GitHub),
   * Accept (varies per call), and an optional Bearer token.
   */
  private async buildHeaders(accept: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "User-Agent": "emploke-catalog-fetcher",
      Accept: accept,
    };
    const token = await resolveDefaultGitHubToken("github.com");
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Original tarball-streaming implementation, kept as the fallback
   * for whole-repo origins (`subPath === null`) and for tree-listing
   * truncation. See class jsdoc for when each transport is used.
   */
  private async *fetchTreeViaTarball(
    uri: string,
    owner: string,
    repo: string,
    ref: string,
    subPath: string | null,
  ): AsyncIterable<EntryFile> {
    const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`;
    const headers = await this.buildHeaders("application/vnd.github+json");

    let response: Response;
    try {
      response = await fetch(tarballUrl, { headers, redirect: "follow" });
    } catch (cause) {
      throw new FetchError(uri, `network error fetching tarball: ${(cause as Error).message}`, {
        cause,
      });
    }
    if (!response.ok) {
      // Drain body so we don't keep the socket open.
      try {
        await response.text();
      } catch {}
      throw new FetchError(
        uri,
        `GitHub tarball API returned ${response.status} ${response.statusText}`,
      );
    }
    if (!response.body) {
      throw new FetchError(uri, "GitHub tarball response has no body");
    }

    // Convert the WHATWG ReadableStream into a Node Readable, then pipe
    // through gunzip + tar extract.
    const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    const gunzip = createGunzip();
    const extract = tar.extract();
    nodeStream.on("error", (err) => extract.destroy(err));
    gunzip.on("error", (err) => extract.destroy(err));
    nodeStream.pipe(gunzip).pipe(extract);

    // Filter setup: strip GitHub's auto-prefix (`<owner>-<repo>-<sha>/`)
    // discovered on the first entry, plus the optional subpath.
    let prefix: string | null = null;
    const subPrefix = subPath ? subPath.replace(/\/+$/, "") : null;

    try {
      for await (const entry of extractEntries(extract)) {
        const { headerName, type, content } = entry;
        if (type !== "file") continue;
        if (prefix === null) {
          // First entry establishes the auto-prefix.
          const slash = headerName.indexOf("/");
          prefix = slash >= 0 ? headerName.slice(0, slash + 1) : "";
        }
        if (!headerName.startsWith(prefix)) continue;
        const afterPrefix = headerName.slice(prefix.length);
        let relPath: string;
        if (subPrefix) {
          // Two cases when a subpath is given:
          //
          //  1) subpath points to a directory:
          //     `<subPrefix>/foo` → relPath = "foo"
          //     `<subPrefix>` itself is a directory entry → no payload, skip.
          //
          //  2) subpath points to a single file (e.g. `mcps/foo.json`):
          //     the only matching entry IS the file; we yield it under its
          //     basename so consumers can identify it. Without this branch
          //     the fetcher would treat the file like case (1)'s directory
          //     entry and silently drop the only payload.
          if (afterPrefix === subPrefix) {
            // Single-file subpath: yield as basename (e.g. "foo.json").
            const slashIdx = subPrefix.lastIndexOf("/");
            relPath = slashIdx >= 0 ? subPrefix.slice(slashIdx + 1) : subPrefix;
          } else if (afterPrefix.startsWith(`${subPrefix}/`)) {
            relPath = afterPrefix.slice(subPrefix.length + 1);
          } else {
            continue;
          }
        } else {
          relPath = afterPrefix;
        }
        if (relPath === "") continue;
        if (content.length > MAX_FILE_BYTES) continue;
        yield { relPath, content };
      }
    } catch (cause) {
      throw new FetchError(uri, `tarball extraction failed: ${(cause as Error).message}`, {
        cause,
      });
    }
  }
}

/**
 * One blob in the recursive Trees API response that we care about
 * (only `path` + `sha`; type/size etc. are filtered out at parse).
 */
interface TreeBlobEntry {
  readonly path: string;
  readonly sha: string;
}

interface TreeListingResponse {
  readonly sha?: string;
  readonly url?: string;
  readonly tree?: ReadonlyArray<{
    readonly path?: unknown;
    readonly type?: unknown;
    readonly sha?: unknown;
  }>;
  readonly truncated?: boolean;
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
}

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

interface RawEntry {
  headerName: string;
  type: string;
  content: Buffer;
}

/**
 * Adapt the event-driven `tar-stream` extract into an async iterable of
 * `RawEntry`. We buffer the per-file content so consumers don't have to
 * worry about back-pressure inside the tar parser; entries are typically
 * small (<100 KB skills) so memory cost is negligible.
 */
async function* extractEntries(extract: tar.Extract): AsyncIterable<RawEntry> {
  const queue: RawEntry[] = [];
  let done = false;
  let error: Error | null = null;
  const wakers: Array<() => void> = [];
  const wake = () => {
    while (wakers.length > 0) wakers.shift()!();
  };

  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      queue.push({
        headerName: header.name,
        type: header.type ?? "file",
        content: Buffer.concat(chunks),
      });
      next();
      wake();
    });
    stream.on("error", (err) => {
      error = err;
      next(err);
      wake();
    });
  });
  extract.on("finish", () => {
    done = true;
    wake();
  });
  extract.on("error", (err) => {
    error = err;
    done = true;
    wake();
  });

  while (true) {
    if (error) throw error;
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (done) return;
    await new Promise<void>((resolve) => wakers.push(resolve));
  }
}

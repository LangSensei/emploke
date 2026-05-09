import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import * as tar from "tar-stream";
import { FetchError } from "./errors.js";
import type { EntryFile, Fetcher } from "./fetcher.js";
import { parseOrigin } from "./origin.js";

/**
 * Fetcher for `https://github.com/<owner>/<repo>/tree/<ref>[/path]` URIs.
 *
 * Strategy: GET the GitHub Tarball API endpoint
 * (`https://api.github.com/repos/{owner}/{repo}/tarball/{ref}`),
 * gunzip + tar-extract on the fly, and yield `EntryFile` records as
 * the stream progresses. No filesystem touch; no `git` binary required.
 *
 * **Auth**: optional. If `GITHUB_TOKEN` (or `GH_TOKEN`) is set in the
 * process env, we attach `Authorization: Bearer <token>` so private
 * repos work and the rate limit goes from 60/h to 5000/h. Anonymous
 * requests work fine for public repos in practice.
 *
 * **Tarball shape**: GitHub wraps the entire tree in a single top-level
 * directory like `<owner>-<repo>-<sha7>/`. We auto-detect that prefix
 * from the first entry and strip it. If the origin specifies a subpath,
 * we additionally filter to entries under that subpath and strip it
 * (so `tree/main/skills/x` yields entries relative to `x/`, not
 * `skills/x/`).
 *
 * **50 MB tarball cap**: enforced by GitHub itself; sufficient for any
 * sane skill / agent / mcp.
 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export class GitHubFetcher implements Fetcher {
  readonly scheme = "github";

  async *fetch(uri: string): AsyncIterable<EntryFile> {
    const origin = parseOrigin(uri);
    if (origin.scheme !== "github") {
      throw new FetchError(uri, "GitHubFetcher only handles github URIs");
    }
    const { owner, repo, ref, path: subPath } = origin;

    const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`;
    const headers: Record<string, string> = {
      "User-Agent": "emploke-catalog-fetcher",
      Accept: "application/vnd.github+json",
    };
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

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
          if (afterPrefix !== subPrefix && !afterPrefix.startsWith(`${subPrefix}/`)) continue;
          relPath = afterPrefix === subPrefix ? "" : afterPrefix.slice(subPrefix.length + 1);
          if (relPath === "") continue; // the subpath itself, no file payload
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

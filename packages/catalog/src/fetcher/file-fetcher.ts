import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { FetchError } from "./errors.js";
import type { EntryFile, Fetcher } from "./fetcher.js";
import { parseOrigin } from "./origin.js";

/**
 * Fetcher for the `file:` scheme. Walks the source directory (or yields a
 * single entry for a single-file source) and emits `EntryFile` records.
 *
 * Symlinks are silently skipped (both file and directory symlinks): the
 * `walk` generator below deliberately does not follow them, to avoid
 * accidental traversal outside the origin root.
 *
 * 50 MB per-file cap mirrors the install-time tree filter in `fetchTree`.
 * Skill/agent/mcp packages are tiny in practice; a file that big in a
 * source tree is almost certainly an accident.
 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export class FileFetcher implements Fetcher {
  readonly scheme = "file";

  async fetchFile(uri: string, relPath: string): Promise<Buffer> {
    const origin = parseOrigin(uri);
    if (origin.scheme !== "file") {
      throw new FetchError(uri, "FileFetcher only handles file: URIs");
    }
    if (typeof relPath !== "string") {
      throw new FetchError(uri, "fetchFile relPath must be a string");
    }
    if (relPath.startsWith("/") || relPath.startsWith("\\")) {
      throw new FetchError(uri, `fetchFile relPath must be relative, got "${relPath}"`);
    }
    let target: string;
    if (relPath === "") {
      // MCP-origin tolerance: when `relPath === ""` and `origin.path`
      // is a directory rather than a single file, pick the
      // alphabetically-first regular file inside. Lets `file:/abs/mcps/`
      // origins resolve without requiring callers to spell the filename
      // in the URI.
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(origin.path);
      } catch (cause) {
        throw new FetchError(uri, `cannot stat origin path: ${(cause as Error).message}`, {
          cause,
        });
      }
      if (st.isFile()) {
        target = origin.path;
      } else if (st.isDirectory()) {
        const entries = (await readdir(origin.path, { withFileTypes: true }))
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        if (entries.length === 0) {
          throw new FetchError(uri, "origin directory contains no regular files");
        }
        target = path.join(origin.path, entries[0] as string);
      } else {
        throw new FetchError(uri, "origin path is neither a regular file nor a directory");
      }
    } else {
      // Origin points at a directory; join POSIX-style relPath against it.
      const segs = relPath.split("/").filter((s) => s !== "");
      target = path.join(origin.path, ...segs);
    }
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(target);
    } catch (cause) {
      throw new FetchError(
        uri,
        `cannot stat ${relPath || "origin path"}: ${(cause as Error).message}`,
        { cause },
      );
    }
    if (!st.isFile()) {
      throw new FetchError(uri, `${relPath || "origin path"} is not a regular file`);
    }
    if (st.size > MAX_FILE_BYTES) {
      throw new FetchError(uri, `file exceeds ${MAX_FILE_BYTES}-byte cap`);
    }
    return readFile(target);
  }

  async *fetchTree(uri: string): AsyncIterable<EntryFile> {
    const origin = parseOrigin(uri);
    if (origin.scheme !== "file") {
      throw new FetchError(uri, "FileFetcher only handles file: URIs");
    }
    const src = origin.path;

    let isDir: boolean;
    try {
      const s = await stat(src);
      isDir = s.isDirectory();
    } catch (cause) {
      throw new FetchError(uri, `cannot stat source path: ${(cause as Error).message}`, {
        cause,
      });
    }

    if (isDir) {
      yield* walk(src, "");
    } else {
      // Single file (mcp .json). Yield as one entry under its basename.
      const s = await stat(src);
      if (s.size > MAX_FILE_BYTES) {
        throw new FetchError(uri, `source file exceeds ${MAX_FILE_BYTES}-byte cap`);
      }
      yield { relPath: path.basename(src), content: await readFile(src) };
    }
  }
}

async function* walk(absRoot: string, relParent: string): AsyncIterable<EntryFile> {
  const here = relParent ? path.join(absRoot, ...relParent.split("/")) : absRoot;
  const entries = await readdir(here, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    const childRel = relParent ? `${relParent}/${ent.name}` : ent.name;
    const abs = path.join(here, ent.name);
    if (ent.isDirectory()) {
      yield* walk(absRoot, childRel);
    } else if (ent.isFile()) {
      const s = await stat(abs);
      if (s.size > MAX_FILE_BYTES) continue;
      yield { relPath: toPosix(childRel), content: await readFile(abs) };
    }
  }
}

function toPosix(p: string): string {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { FetchError } from "./errors.js";
import type { EntryFile, Fetcher } from "./fetcher.js";
import { parseOrigin } from "./origin.js";

/**
 * Fetcher for the `file:` scheme. Walks the source directory (or yields a
 * single entry for a single-file source) and emits `EntryFile` records.
 *
 * Symlinks are silently skipped (both file and directory symlinks); see
 * `walkInner` for rationale (mirrors the catalog repository walker).
 *
 * 50 MB per-file cap matches the catalog walker. Skill/agent/mcp packages
 * are tiny in practice; a file that big in a source tree is almost
 * certainly an accident and would also be rejected on `entries()` later.
 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export class FileFetcher implements Fetcher {
  readonly scheme = "file";

  async *fetch(uri: string): AsyncIterable<EntryFile> {
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

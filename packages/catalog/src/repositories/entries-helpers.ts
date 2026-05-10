import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { mkdirP, replaceDirAtomic, safeStat } from "@emploke/fs";
import { NotFound } from "../errors.js";
import type { CatalogEntryFile } from "./repository.js";

/**
 * Walk `rootDir` recursively, yielding `{ relPath, content }` for every
 * regular file. `relPath` is always POSIX-style (`/`), regardless of host
 * OS, so consumers (especially the runtime that bakes skills into a
 * session workdir) can safely string-prefix without re-normalising.
 *
 * **Symlinks are silently skipped** (both file and directory symlinks).
 * Following them would let a malicious or accidentally-installed catalog
 * entry escape its own directory and leak host files (e.g. an installed
 * skill containing `evil -> /etc/passwd` or `loop -> .`). We don't
 * complicate the surface with realpath-based whitelisting; the strict
 * "no symlinks at all" rule matches what a SQLite-backed repository
 * would naturally enforce (rows have no symlink concept).
 *
 * `kind`/`name` are used only to build a {@link NotFound} error when the
 * root dir is missing; the rest of the walk is silent.
 */
export async function* walkEntryDir(
  kind: "skill" | "agent",
  name: string,
  rootDir: string,
): AsyncIterable<CatalogEntryFile> {
  if ((await safeStat(rootDir)) === null) throw new NotFound(kind, name);
  yield* walkInner(rootDir, "");
}

/**
 * Drain `stream` into `dest`, atomically. Files are first written into
 * a fresh dir under `tmpRoot/`, then the whole tree is swapped in via
 * `replaceDirAtomic`.
 *
 * The catalog repositories all pass `<catalogDir>/.tmp` as `tmpRoot`,
 * giving us a single well-known place for in-progress installs:
 *
 *   - Out of every scanner's path (`skills/`, `agents/`, `mcps/` are
 *     siblings of `.tmp`).
 *   - Same filesystem as `dest` (replaceDirAtomic needs same-volume
 *     for atomic rename).
 *   - One sweep at boot time cleans crash-leftovers
 *     (`rm -rf <catalogDir>/.tmp/*`).
 *
 * Per-file safety:
 *   - `relPath` is always normalised to POSIX before joining — incoming
 *     path may have come from a remote tarball (slash separators).
 *   - Reject any `..` segment to prevent path-escape from a malicious
 *     fetcher result.
 *   - Reject absolute paths for the same reason.
 *
 * The temp dir is always cleaned up on failure.
 */
export async function installStreamToDir(
  tmpRoot: string,
  dest: string,
  stream: AsyncIterable<CatalogEntryFile>,
): Promise<void> {
  await mkdirP(dirname(dest));
  await mkdir(tmpRoot, { recursive: true });
  const tmp = join(tmpRoot, `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
  try {
    for await (const file of stream) {
      const segments = file.relPath.split("/").filter((s) => s.length > 0);
      if (segments.length === 0) continue;
      if (segments.some((s) => s === "..") || file.relPath.startsWith("/")) {
        throw new Error(`unsafe relPath in stream: ${file.relPath}`);
      }
      const abs = join(tmp, ...segments);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content);
    }
    await replaceDirAtomic(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function* walkInner(absRoot: string, relParent: string): AsyncIterable<CatalogEntryFile> {
  const here = relParent ? join(absRoot, ...relParent.split("/")) : absRoot;
  const entries = await readdir(here, { withFileTypes: true });
  for (const ent of entries) {
    // Skip symlinks before doing anything else. On Windows
    // `Dirent.isDirectory()` returns true for symlinks pointing at dirs,
    // which would otherwise let the recursive walk descend through a
    // symlinked-out target and yield arbitrary host files.
    if (ent.isSymbolicLink()) continue;
    const childRel = relParent ? `${relParent}/${ent.name}` : ent.name;
    const abs = join(here, ent.name);
    if (ent.isDirectory()) {
      yield* walkInner(absRoot, childRel);
    } else if (ent.isFile()) {
      // Defense: skip anything obviously massive — skills/agents are
      // text + small assets. A 50 MB file in a skill dir is almost
      // certainly an accident; refuse rather than load it.
      const s = await safeStat(abs);
      if (s !== null && s.size > 50 * 1024 * 1024) continue;
      yield { relPath: toPosix(childRel), content: await readFile(abs) };
    }
  }
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

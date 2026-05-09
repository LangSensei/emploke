import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathExists } from "../atomic.js";
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
  if (!(await pathExists(rootDir))) throw new NotFound(kind, name);
  yield* walkInner(rootDir, "");
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
      const s = await stat(abs);
      if (s.size > 50 * 1024 * 1024) continue;
      yield { relPath: toPosix(childRel), content: await readFile(abs) };
    }
  }
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

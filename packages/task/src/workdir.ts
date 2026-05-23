import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Returns absolute paths of regular files directly under
 * `<workdir>/<subPath>`. Does NOT recurse into nested directories
 * (the framing.ts convention is a flat `./artifact/`). Returns `[]` if
 * the subdir does not exist (ENOENT) — every other fs error rethrows.
 *
 * Output is sorted lexicographically by the entry name for determinism
 * (tests and downstream consumers can rely on a stable order without
 * having to sort again).
 */
export async function listWorkdirFiles(workdir: string, subPath: string): Promise<string[]> {
  const dir = path.join(workdir, subPath);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  files.sort((a, b) => a.localeCompare(b));
  return files.map((name) => path.join(dir, name));
}

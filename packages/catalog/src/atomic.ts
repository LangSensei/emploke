import { randomBytes } from "node:crypto";
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Best-effort atomic directory replacement.
 *
 * Strategy:
 *   1. Copy `src` recursively into a sibling temp dir of `dst`.
 *   2. If `dst` exists, rename it aside to a backup path.
 *   3. Rename the temp dir to `dst` (atomic on the same filesystem).
 *   4. Remove the backup.
 *
 * Failure modes:
 *   - If step 3 fails after the backup rename, we attempt to restore from
 *     backup; if that restore also fails, the backup is left on disk.
 *   - Any leftover temp / backup directories share a recognizable prefix
 *     (".<basename>.tmp." / ".<basename>.old.") so a future scan can ignore
 *     or clean them.
 *
 * This is not a true cross-volume atomic op (POSIX rename across mounts is
 * not atomic), but the catalog roots all live under one filesystem in
 * practice. Cross-volume support would require a different strategy and is
 * out of scope.
 */
export async function atomicReplaceDir(src: string, dst: string): Promise<void> {
  const parent = dirname(dst);
  await mkdir(parent, { recursive: true });

  const stamp = randomBytes(6).toString("hex");
  const tmp = join(parent, `.${basename(dst)}.tmp.${stamp}`);
  const bak = join(parent, `.${basename(dst)}.old.${stamp}`);

  await cp(src, tmp, { recursive: true });

  let backedUp = false;
  if (await pathExists(dst)) {
    await rename(dst, bak);
    backedUp = true;
  }
  try {
    await rename(tmp, dst);
  } catch (err) {
    if (backedUp) {
      try {
        await rename(bak, dst);
      } catch {
        // restore failed; leave bak in place for manual recovery
      }
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  if (backedUp) {
    await rm(bak, { recursive: true, force: true }).catch(() => {});
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

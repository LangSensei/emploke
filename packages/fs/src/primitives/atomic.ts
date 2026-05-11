import { randomBytes } from "node:crypto";
import { cp, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { safeStat } from "./safe-fs.js";

/**
 * On Windows, rename can race with a reader on the destination
 * (`MoveFileEx` returns EPERM/EACCES if any process has the dest open
 * even briefly without share-delete). Dashboard pollers reading
 * task.json / session.json hit this in practice. We retry the rename
 * a few times with a tiny backoff before giving up — the contention
 * window is microseconds, so even 1-2 retries normally suffice.
 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Total worst-case wait across all attempts is ~127 ms (1 + 2 + 4 + 8 +
 * 16 + 32 + 32 + 32). Sized to comfortably absorb the dashboard's 4s
 * task.json poll cadence. The cap exists so a genuinely stuck destination
 * (antivirus full-scan holding the file, broken share, disk going
 * read-only) eventually surfaces as an error rather than pinning the
 * writer indefinitely.
 */
const RENAME_MAX_ATTEMPTS = 8;

/**
 * Atomically write `content` to `absPath`.
 *
 * Strategy: write to a uniquely-suffixed tmp file, then rename into place.
 * Readers see either the previous file or the new one, never partial bytes
 * (POSIX rename + Windows >= Node 18 give same-fs atomicity guarantees).
 *
 * The tmp filename includes pid + 8 random hex chars so two concurrent
 * writers cannot clobber each other's tmp file or trigger an ENOENT on
 * rename when the second writer's tmp gets renamed away by the first.
 */
export async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, content, "utf8");
  try {
    await renameWithRetry(tmp, absPath);
  } catch (err) {
    // Best-effort cleanup so we don't leave orphan tmp files behind on
    // failure. Ignore the unlink error itself — the original error is
    // what the caller needs to see.
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}

/**
 * Atomically write a JSON value with a trailing newline.
 */
export async function writeJsonAtomic<T>(absPath: string, value: T): Promise<void> {
  await writeFileAtomic(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== undefined && RENAME_RETRY_CODES.has(code)) {
        lastErr = err;
        // Exponential-ish backoff capped low: 1, 2, 4, 8, 16, 32, 32, 32 ms.
        const delayMs = Math.min(32, 1 << attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Best-effort atomic directory tree replacement.
 *
 * Strategy (when `scratchDir` is provided — the recommended path):
 *   1. If `dstDir` exists, rename it aside to `<scratchDir>/.bak.<stamp>`
 *      (atomic on same FS).
 *   2. Rename `srcDir` → `dstDir` (atomic on same FS).
 *   3. Remove the backup.
 *   Failure rollback: if step 2 fails after step 1, restore from backup.
 *
 * Both `srcDir` and `scratchDir` MUST be on the same filesystem as
 * `dstDir`'s parent (renames across volumes aren't atomic). All
 * intermediate state lives in `scratchDir`, so callers can wipe
 * `scratchDir/*` on boot to clean crash leftovers without scanning
 * the catalog tree.
 *
 * Strategy (legacy path, when `scratchDir` is omitted):
 *   1. Copy `srcDir` recursively into `<dstDir.parent>/.<basename>.tmp.<stamp>`.
 *   2. If `dstDir` exists, rename it to `<dstDir.parent>/.<basename>.old.<stamp>`.
 *   3. Rename the copy to `dstDir`.
 *   4. Remove the backup.
 *   This path supports any srcDir input (potentially cross-FS) but
 *   leaves `.<basename>.tmp.<stamp>` and `.<basename>.old.<stamp>`
 *   leftovers on crash, both inside `dstDir.parent` — which is in the
 *   scan path for catalog repositories. Prefer the scratchDir path.
 *
 * Failure modes (legacy path):
 *   - If step 3 fails after the backup rename, we attempt to restore
 *     from backup; if that restore also fails, the backup is left on
 *     disk under `<parent>/.<basename>.old.<stamp>`.
 *   - Any leftover temp / backup directories share a recognizable prefix
 *     so a future scan can skip them.
 */
export async function replaceDirAtomic(
  srcDir: string,
  dstDir: string,
  opts?: { scratchDir?: string },
): Promise<void> {
  const parent = dirname(dstDir);
  await mkdir(parent, { recursive: true });

  const stamp = randomBytes(6).toString("hex");

  if (opts?.scratchDir !== undefined) {
    // Fast path: src is already same-FS, scratchDir is out of scan path.
    // No copy, no leftovers in dstDir.parent.
    await mkdir(opts.scratchDir, { recursive: true });
    const bak = join(opts.scratchDir, `.bak.${basename(dstDir)}.${stamp}`);
    let backedUp = false;
    if ((await safeStat(dstDir)) !== null) {
      await rename(dstDir, bak);
      backedUp = true;
    }
    try {
      await renameWithRetry(srcDir, dstDir);
    } catch (err) {
      if (backedUp) {
        try {
          await rename(bak, dstDir);
        } catch {
          // restore failed; bak stays in scratchDir, will be wiped on next boot
        }
      }
      // src may or may not still exist; clean up best-effort
      await rm(srcDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    if (backedUp) {
      await rm(bak, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  // Legacy path (cross-FS-tolerant copy + sibling tmp/bak).
  const tmp = join(parent, `.${basename(dstDir)}.tmp.${stamp}`);
  const bak = join(parent, `.${basename(dstDir)}.old.${stamp}`);

  await cp(srcDir, tmp, { recursive: true });

  let backedUp = false;
  if ((await safeStat(dstDir)) !== null) {
    await rename(dstDir, bak);
    backedUp = true;
  }
  try {
    await renameWithRetry(tmp, dstDir);
  } catch (err) {
    if (backedUp) {
      try {
        await rename(bak, dstDir);
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

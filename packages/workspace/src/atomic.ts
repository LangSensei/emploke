import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

/**
 * Cross-platform file lock + atomic write helpers, identical in spirit to
 * the routine `provisionCopilotWorkdir` uses for `~/.copilot/settings.json`.
 *
 * Kept inside this package (rather than shared with `@emploke/runtime`) so
 * `@emploke/workspace` has zero non-paths dependencies. If a third site
 * needs the same logic later, factor out into `@emploke/fs-utils`.
 */

/** Default time to wait for a contended lock before failing. */
const LOCK_WAIT_MS = 5000;
/**
 * Time after which an existing lock file is *eligible* for stale-recovery
 * via mtime alone. Even past this threshold we still try a PID liveness
 * check first; the mtime threshold is the fallback for the case where the
 * holder PID could not be parsed.
 */
const LOCK_STALE_MS = 30000;
/** Poll interval while waiting on a contended lock. */
const LOCK_POLL_MS = 50;

/**
 * Acquire an advisory lock on `lockPath`, run `fn`, then release.
 * `O_EXCL` create-or-fail under the hood; the fs guarantees exactly one
 * caller wins the race.
 *
 * If acquisition fails because the lock already exists, polls for up to
 * `LOCK_WAIT_MS`; each poll re-checks staleness. Stale-recovery is
 * conservative:
 *   - If we can read a PID from the lock file and that PID is still alive
 *     (`process.kill(pid, 0)` does not throw), we treat the lock as held
 *     no matter how old it is (long-running fn() must not be evicted).
 *   - Only when the PID is dead, unparseable, or absent AND the file is
 *     older than `LOCK_STALE_MS` do we steal the lock.
 *
 * On release we only `unlink` the file if its contents still match our
 * own PID — guarding against the (now very narrow) race where another
 * waiter stole the lock from underneath a long-running fn().
 *
 * The lock is released in `finally`, so a thrown `fn` cannot wedge subsequent
 * calls.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const myPid = process.pid;
  const myMarker = `${myPid}\n`;
  while (true) {
    try {
      const fh = await open(lockPath, "wx");
      try {
        await fh.write(myMarker);
      } catch {
        // Diagnostic write failure is non-fatal; the lock itself is held.
      }
      await fh.close();
      try {
        return await fn();
      } finally {
        await releaseIfMine(lockPath, myMarker);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      if (Date.now() - start > LOCK_WAIT_MS) {
        const holder = await readLockHolder(lockPath);
        const detail = holder !== null ? ` (held by PID ${holder})` : "";
        throw new Error(`timed out (${LOCK_WAIT_MS}ms) acquiring lock on ${lockPath}${detail}`);
      }

      if (await tryStealStaleLock(lockPath)) continue;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

/**
 * Inspect the lock file and `unlink` it iff it is safely stealable.
 * Returns true if the caller should immediately retry acquisition.
 *
 * Order of checks:
 *   1. If we can read a PID and `process.kill(pid, 0)` succeeds, the holder
 *      is alive — never steal, regardless of mtime.
 *   2. If the holder PID is dead (ESRCH), steal.
 *   3. If the PID is unparseable or unreadable AND mtime is older than
 *      `LOCK_STALE_MS`, steal as a last resort.
 *   4. Otherwise leave it alone and let the poll loop wait.
 */
async function tryStealStaleLock(lockPath: string): Promise<boolean> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(lockPath);
  } catch {
    // Lock file vanished between EEXIST and stat — race; retry now.
    return true;
  }

  const holder = await readLockHolder(lockPath);
  if (holder !== null) {
    if (isProcessAlive(holder)) return false;
    // Holder dead — steal regardless of mtime.
    await unlinkIgnoreMissing(lockPath);
    return true;
  }

  // Couldn't read PID — fall back to mtime-only stale check.
  if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
    await unlinkIgnoreMissing(lockPath);
    return true;
  }
  return false;
}

/**
 * Release the lock only if the file still contains our PID. Protects
 * against accidentally deleting a lock that another process legitimately
 * stole from us during a long-running fn().
 */
async function releaseIfMine(lockPath: string, expectedMarker: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    // Already gone — fine.
    return;
  }
  if (raw === expectedMarker) {
    await unlinkIgnoreMissing(lockPath);
  }
  // else: someone else owns it now; leave it alone.
}

async function unlinkIgnoreMissing(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    // Stale-recovery in another process may have unlinked already; fine.
  }
}

/** Best-effort read of the PID written by the current lock holder. */
async function readLockHolder(lockPath: string): Promise<number | null> {
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * `process.kill(pid, 0)` returns nothing on success and throws ESRCH if the
 * pid is dead. EPERM means "exists but I don't own it" — treat as alive.
 * Any other error: be conservative and assume alive (don't steal).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

/**
 * Write `content` to `targetPath` atomically: pid-suffixed tmp file + rename.
 * Readers see either the previous file or the new one, never partial bytes
 * (POSIX rename + Windows >= Node 18).
 */
export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, targetPath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}

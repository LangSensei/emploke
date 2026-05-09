import { open, readFile, stat, unlink } from "node:fs/promises";

/**
 * Default time to wait for a contended lock before failing. Callers can
 * override via the `waitMs` option for long-running critical sections.
 */
const DEFAULT_WAIT_MS = 5000;

/**
 * Time after which an existing lock file is *eligible* for stale-recovery
 * via mtime alone. Even past this threshold we still try a PID liveness
 * check first; the mtime threshold is the fallback for the case where the
 * holder PID could not be parsed.
 */
const DEFAULT_STALE_MS = 30000;

/** Poll interval while waiting on a contended lock. */
const POLL_INTERVAL_MS = 50;

/** Thrown when `withFileLock` cannot acquire a contended lock within `waitMs`. */
export class FsLockTimeoutError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly waitedMs: number,
    public readonly holderPid: number | null,
  ) {
    const detail = holderPid !== null ? ` (held by PID ${holderPid})` : "";
    super(`timed out (${waitedMs}ms) acquiring lock on ${lockPath}${detail}`);
    this.name = "FsLockTimeoutError";
  }
}

export interface WithFileLockOpts {
  /** Time to wait for a contended lock before failing. Default 5000ms. */
  readonly waitMs?: number;
  /**
   * Time after which a lock file with an unparseable / dead holder is
   * treated as stale. Default 30000ms.
   */
  readonly staleMs?: number;
}

/**
 * Acquire an advisory lock on `lockPath`, run `fn`, then release.
 * `O_EXCL` create-or-fail under the hood; the fs guarantees exactly one
 * caller wins the race.
 *
 * If acquisition fails because the lock already exists, polls for up to
 * `waitMs`; each poll re-checks staleness. Stale-recovery is conservative:
 *   - If we can read a PID from the lock file and that PID is still alive
 *     (`process.kill(pid, 0)` does not throw), we treat the lock as held
 *     no matter how old it is (long-running fn() must not be evicted).
 *   - Only when the PID is dead, unparseable, or absent AND the file is
 *     older than `staleMs` do we steal the lock.
 *
 * On release we only `unlink` the file if its contents still match our
 * own PID — guarding against the (now very narrow) race where another
 * waiter stole the lock from underneath a long-running fn().
 *
 * The lock is released in `finally`, so a thrown `fn` cannot wedge
 * subsequent calls.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: WithFileLockOpts = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const start = Date.now();
  const myPid = process.pid;
  const myMarker = `${myPid}\n`;
  while (true) {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(lockPath, "wx");
      try {
        await fh.write(myMarker);
      } catch {
        // Diagnostic write failure is non-fatal; the lock itself is held.
      }
      await fh.close();
      fh = null;
      try {
        return await fn();
      } finally {
        await releaseIfMine(lockPath, myMarker);
      }
    } catch (err) {
      // Make sure we don't leak a still-open handle (close() above may
      // have thrown after `open` succeeded). Also release the on-disk
      // lock file we just created if we never reached the fn() critical
      // section — otherwise stale-recovery would have to wait `staleMs`
      // before another caller could proceed.
      if (fh) {
        await fh.close().catch(() => {});
        await releaseIfMine(lockPath, myMarker);
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      if (Date.now() - start > waitMs) {
        const holder = await readLockHolder(lockPath);
        throw new FsLockTimeoutError(lockPath, waitMs, holder);
      }

      if (await tryStealStaleLock(lockPath, staleMs)) continue;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

async function tryStealStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
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
  if (Date.now() - st.mtimeMs > staleMs) {
    await unlinkIgnoreMissing(lockPath);
    return true;
  }
  return false;
}

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
 * `process.kill(pid, 0)` returns nothing on success and throws ESRCH if
 * the pid is dead. EPERM means "exists but I don't own it" — treat as
 * alive. Any other error: be conservative and assume alive (don't steal).
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

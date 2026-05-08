import { open, rename, stat, unlink, writeFile } from "node:fs/promises";

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
/** Time after which an existing lock file is considered abandoned. */
const LOCK_STALE_MS = 30000;
/** Poll interval while waiting on a contended lock. */
const LOCK_POLL_MS = 50;

/**
 * Acquire an advisory lock on `lockPath`, run `fn`, then release.
 * `O_EXCL` create-or-fail under the hood; the fs guarantees exactly one
 * caller wins the race.
 *
 * If acquisition fails because the lock already exists, polls for up to
 * `LOCK_WAIT_MS`; each poll re-checks staleness, so a crashed holder
 * eventually unblocks waiters via `LOCK_STALE_MS` recovery. After the
 * timeout we throw with the holder PID for diagnostics.
 *
 * The lock is released in `finally`, so a thrown `fn` cannot wedge subsequent
 * calls.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      const fh = await open(lockPath, "wx");
      try {
        await fh.write(`${process.pid}\n`);
      } catch {
        // Diagnostic write failure is non-fatal; the lock itself is held.
      }
      await fh.close();
      try {
        return await fn();
      } finally {
        try {
          await unlink(lockPath);
        } catch {
          // Stale-recovery in another process may have unlinked already; fine.
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      if (Date.now() - start > LOCK_WAIT_MS) {
        const holder = await readLockHolder(lockPath);
        const detail = holder !== null ? ` (held by PID ${holder})` : "";
        throw new Error(`timed out (${LOCK_WAIT_MS}ms) acquiring lock on ${lockPath}${detail}`);
      }

      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            await unlink(lockPath);
          } catch {}
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

/** Best-effort read of the PID written by the current lock holder. */
async function readLockHolder(lockPath: string): Promise<number | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = (await readFile(lockPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
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

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock, writeFileAtomic } from "../src/atomic.js";

let scratch: string;
let lockPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "emploke-ws-atomic-"));
  lockPath = path.join(scratch, ".lock");
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Find a PID that the OS reports as definitely-dead. We need this to
 * exercise the stale-recovery code path; on most systems any sufficiently
 * large positive integer works because PIDs wrap well below it. We verify
 * with `process.kill(pid, 0)` to make sure ESRCH actually fires before
 * relying on the value, so the test stays self-checking.
 */
function findDeadPid(): number | null {
  for (const candidate of [99999999, 999999, 9999999]) {
    try {
      process.kill(candidate, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  return null;
}

describe("withFileLock", () => {
  it("writes the holder PID into the lock file while fn runs", async () => {
    let observed: string | null = null;
    await withFileLock(lockPath, async () => {
      observed = await readFile(lockPath, "utf8");
    });
    expect(observed).toBe(`${process.pid}\n`);
  });

  it("removes the lock file after fn completes", async () => {
    await withFileLock(lockPath, async () => {});
    expect(await exists(lockPath)).toBe(false);
  });

  it("removes the lock file even if fn throws", async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await exists(lockPath)).toBe(false);
  });

  it("does NOT delete the lock if a third party stole it mid-fn", async () => {
    // Simulates the race the new releaseIfMine guard prevents:
    //   1. We acquire and start fn().
    //   2. Some other holder rewrites the lock file with their own PID.
    //   3. Our fn() finishes; we must NOT unlink the file we no longer own.
    await withFileLock(lockPath, async () => {
      await writeFile(lockPath, "424242\n", "utf8");
    });
    // The "stolen" lock file is still on disk because the contents stopped
    // matching our PID before release.
    expect(await readFile(lockPath, "utf8")).toBe("424242\n");
  });

  it("steals a lock whose recorded PID is dead (ESRCH), not bound by mtime", async () => {
    const dead = findDeadPid();
    if (dead === null) {
      // No portable way to forge a dead PID on this host; skip.
      return;
    }
    // Pre-place a "fresh" lock file (mtime = now) but with a dead PID. The
    // PID-liveness check should let us steal it well before LOCK_STALE_MS.
    await writeFile(lockPath, `${dead}\n`, "utf8");
    const before = Date.now();
    await withFileLock(lockPath, async () => {
      // We got in.
    });
    const elapsed = Date.now() - before;
    // Sanity: not waiting anywhere near the 30s mtime threshold.
    expect(elapsed).toBeLessThan(2000);
  });

  it("waits for a live holder (does not steal even if poll loop sees it for a while)", async () => {
    // First lock holder runs ~150ms; the second acquirer must wait, not
    // steal. (Hard ceiling: well under LOCK_WAIT_MS.)
    let secondStarted = 0;
    let firstFinished = 0;
    const first = withFileLock(lockPath, async () => {
      await delay(150);
      firstFinished = Date.now();
    });
    // Give the first acquirer a tick to actually take the lock.
    await delay(10);
    const second = withFileLock(lockPath, async () => {
      secondStarted = Date.now();
    });
    await Promise.all([first, second]);
    expect(secondStarted).toBeGreaterThanOrEqual(firstFinished);
  });

  it("survives back-to-back acquisitions", async () => {
    for (let i = 0; i < 5; i++) {
      await withFileLock(lockPath, async () => {});
    }
    expect(await exists(lockPath)).toBe(false);
  });
});

describe("writeFileAtomic", () => {
  it("writes the requested content to targetPath", async () => {
    const target = path.join(scratch, "out.json");
    await writeFileAtomic(target, '{"k":1}\n');
    expect(await readFile(target, "utf8")).toBe('{"k":1}\n');
  });

  it("does not leave its tmp file behind on success", async () => {
    const target = path.join(scratch, "out.json");
    await writeFileAtomic(target, "ok");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(scratch);
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
  });
});

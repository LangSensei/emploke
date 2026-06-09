/**
 * Read / write / inspect `<EMPLOKE_HOME>/runtime.json` — the breadcrumb the
 * lifecycle commands (`start`, `stop`, `restart`, `status`) leave on disk
 * so a later CLI invocation can find the running server, talk to it, and
 * clean up after it.
 *
 * Atomic writes use the `write-file-atomic` library (write-temp + rename)
 * so a second `emploke status` invocation racing the writer never sees a
 * half-written JSON payload.
 *
 * The on-disk shape (`RuntimeFile`) is owned by `@emploke/server`
 * because the server is the writer; this module provides the CLI-side
 * IO around that shared shape. (Server publishes the shape, CLI
 * consumes it — both sides linked by the `cli → server` workspace dep
 * that already exists for `runServer`.)
 */

import { mkdir, readFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { type RuntimeFile, runtimeFilePath } from "@emploke/server";
import writeFileAtomic from "write-file-atomic";

export type { RuntimeFile };
export { runtimeFilePath };

/**
 * Read the runtime file. Returns `null` if the file is absent (the
 * "server not running" steady state); throws on any other read /
 * parse error so the caller can surface it instead of papering over a
 * corrupted file.
 */
export async function readRuntimeFile(home: string): Promise<RuntimeFile | null> {
  try {
    const buf = await readFile(runtimeFilePath(home), "utf8");
    const parsed = JSON.parse(buf) as RuntimeFile;
    if (parsed.schema !== 1) {
      throw new Error(`runtime.json schema ${parsed.schema} unsupported (expected 1)`);
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Atomically write the runtime file. Creates `<home>` first because the
 * user may have wiped it between sessions.
 */
export async function writeRuntimeFile(home: string, value: RuntimeFile): Promise<void> {
  await mkdir(home, { recursive: true });
  const p = runtimeFilePath(home);
  await writeFileAtomicWithRetry(p, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Wrap `write-file-atomic` with a bounded retry on Windows-typical
 * transient rename failures (EPERM / EBUSY / EACCES). The library does
 * a single `fs.rename`; on Windows that translates to
 * `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`, which loses to AV scans of
 * the temp file and to concurrent renames against the same target.
 * The retry budget is small (8 attempts, ~exponential backoff capped
 * at 500 ms) so a genuinely stuck write still fails in well under a
 * second.
 */
async function writeFileAtomicWithRetry(p: string, body: string): Promise<void> {
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFileAtomic(p, body);
      if (attempt > 0) {
        console.debug(`[runtime-file] retried-write path=${p} attempts=${attempt + 1}`);
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= MAX_ATTEMPTS - 1) {
        if (retryable) {
          console.debug(`[runtime-file] giving-up path=${p} attempts=${attempt + 1} code=${code}`);
        }
        throw err;
      }
      const backoffMs = Math.min(2 ** attempt + Math.random() * 50, 500);
      await delay(backoffMs);
    }
  }
}

/** Idempotent delete. Tolerates a missing file (already cleaned up). */
export async function deleteRuntimeFile(home: string): Promise<void> {
  try {
    await unlink(runtimeFilePath(home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Probe whether a process is currently live at `pid`. Uses the standard
 * "send signal 0" trick: throws ESRCH when the slot is empty, returns
 * normally when the slot is occupied. EPERM means a process is at that
 * pid but is owned by another user — for our purpose ("is the slot
 * taken?") that is still alive.
 *
 * Cross-platform: Node maps signal 0 to a no-op kill on POSIX and to
 * `OpenProcess` on Windows.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

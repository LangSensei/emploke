/**
 * `emploke stop` — read `runtime.json`, send SIGTERM to the recorded pid,
 * wait for the process to exit (graceful-shutdown handler in the server
 * does the heavy lifting), escalate to SIGKILL if the grace period
 * elapses, then delete `runtime.json`.
 *
 * Idempotent: a missing file or a dead pid both surface as success
 * (with a note when we cleaned up a stale breadcrumb).
 *
 * Windows note: `process.kill(pid, signal)` on Windows is mapped to
 * `TerminateProcess` regardless of the signal name — there is no
 * graceful equivalent of POSIX SIGTERM. The server's
 * `gracefulShutdown` handler therefore will NOT run on Windows. The
 * server's persistence layer is atomic-write (`@emploke/fs`), so this
 * forces no corruption; in-flight task subprocesses can still be
 * orphaned and are cleaned up on the next server boot via the
 * `recoverOrphaned` sweep. A future graceful-shutdown HTTP endpoint
 * can fix this — tracked separately.
 */

import { setTimeout as delay } from "node:timers/promises";
import { resolveEmplokePaths } from "@emploke/paths";
import type { CommandResult } from "../result.js";
import { deleteRuntimeFile, isPidAlive, readRuntimeFile } from "../runtime-file.js";

export interface StopOpts {
  readonly home?: string;
  /** Total time to wait for SIGTERM to take effect before SIGKILL. Default 30000 ms. */
  readonly gracePeriodMs?: number;
  /** Polling interval while waiting for the pid to exit. Default 250 ms. */
  readonly pollIntervalMs?: number;
}

export async function stop(opts: StopOpts = {}): Promise<CommandResult> {
  const env = process.env;
  const paths = resolveEmplokePaths(
    opts.home !== undefined ? { ...env, EMPLOKE_HOME: opts.home } : env,
  );
  const home = paths.home;
  const existing = await readRuntimeFile(home);
  if (!existing) {
    return { exitCode: 0, stdout: "emploke is not running\n" };
  }
  if (!isPidAlive(existing.pid)) {
    await deleteRuntimeFile(home);
    return {
      exitCode: 0,
      stdout: `emploke is not running (cleaned up stale runtime.json for pid ${existing.pid})\n`,
    };
  }

  try {
    process.kill(existing.pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      return {
        exitCode: 1,
        stderr: `failed to send SIGTERM to pid ${existing.pid}: ${(err as Error).message}\n`,
      };
    }
    // Race: process exited between isPidAlive and kill — fine, fall through.
  }

  const grace = opts.gracePeriodMs ?? 30_000;
  const interval = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + grace;
  while (Date.now() < deadline) {
    if (!isPidAlive(existing.pid)) break;
    await delay(interval);
  }

  let escalated = false;
  if (isPidAlive(existing.pid)) {
    escalated = true;
    try {
      process.kill(existing.pid, "SIGKILL");
    } catch {
      // Already gone or denied — fall through to cleanup.
    }
    // Brief grace for the OS to reap.
    await delay(500);
  }

  await deleteRuntimeFile(home);
  return {
    exitCode: 0,
    stdout: escalated
      ? `emploke stopped (pid ${existing.pid}; escalated to SIGKILL after ${grace}ms)\n`
      : `emploke stopped (pid ${existing.pid})\n`,
  };
}

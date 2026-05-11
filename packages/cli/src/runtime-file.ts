/**
 * Read / write / inspect `<EMPLOKE_HOME>/runtime.json` — the breadcrumb the
 * lifecycle commands (`start`, `stop`, `restart`, `status`) leave on disk
 * so a later CLI invocation can find the running server, talk to it, and
 * clean up after it.
 *
 * Sensitive: when `apiKey` is recorded, the file is `chmod 0600` on POSIX
 * so a same-host non-owner cannot read the API key out of it. Windows ACLs
 * are not adjusted (the `chmod` syscall has no ACL semantics there); the
 * Windows `<home>` is per-user already, which provides equivalent
 * protection.
 *
 * Atomic writes use `@emploke/fs.writeJsonAtomic` so a second `emploke
 * status` invocation racing the writer never sees a half-written JSON
 * payload.
 */

import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "@emploke/fs";

/**
 * Shape persisted to disk. Bumped together with any breaking change so
 * stale files from a previous emploke version surface as "stale" rather
 * than silently misparsing.
 */
export interface RuntimeFile {
  /** Schema version — bump on breaking changes. */
  readonly schema: 1;
  /** Pid of the detached server process. */
  readonly pid: number;
  /** Bind host (mirrors `EMPLOKE_HOST` passed to `start`). */
  readonly host: string;
  /** Listening port (mirrors `PORT` passed to `start`). */
  readonly port: number;
  /**
   * API key the server expects on `/api/*` requests. Only present when a
   * key was passed to `start`. Allows other CLI invocations on the same
   * host to talk to the server without re-supplying the key. File is
   * `chmod 0600` when this field is set.
   */
  readonly apiKey?: string;
  /** ISO 8601 timestamp captured at `start` time. */
  readonly startedAt: string;
  /**
   * Argv the spawned child saw, captured for diagnostics — useful when
   * `status` wants to show why the file is stale (different bundle path,
   * different flags, ...).
   */
  readonly serverArgs: readonly string[];
}

/** Resolve `<home>/runtime.json`. Pure: no fs access. */
export function runtimeFilePath(home: string): string {
  return path.join(home, "runtime.json");
}

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
 * user may have wiped it between sessions. When `apiKey` is present, the
 * file is `chmod 0600` (best-effort: the chmod is a no-op for ACLs on
 * Windows, but the Windows `<home>` is already per-user).
 */
export async function writeRuntimeFile(home: string, value: RuntimeFile): Promise<void> {
  await mkdir(home, { recursive: true });
  const p = runtimeFilePath(home);
  await writeJsonAtomic(p, value);
  if (value.apiKey !== undefined && value.apiKey !== "") {
    try {
      await chmod(p, 0o600);
    } catch {
      // POSIX: shouldn't happen for an owner-writable file we just created.
      // Windows: chmod can't tighten ACLs; skip silently.
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

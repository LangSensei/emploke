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
 * The on-disk shape (`RuntimeFile`) is owned by `@emploke/api-types`
 * because the server writes it and the CLI reads it; this module
 * provides the CLI-side IO around that shared shape.
 */

import { mkdir, readFile, unlink } from "node:fs/promises";
import * as apiTypes from "@emploke/api-types";
import writeFileAtomic from "write-file-atomic";

// Single source of truth for the api-types path: any rename of the
// upstream package only needs touching this import. The two re-exports
// (`type RuntimeFile`, `runtimeFilePath`) pass the public types
// through this module so cli consumers keep their existing import
// paths without depending on @emploke/api-types directly.
type RuntimeFile = apiTypes.RuntimeFile;
const runtimeFilePath = apiTypes.runtimeFilePath;

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
  await writeFileAtomic(p, `${JSON.stringify(value, null, 2)}\n`);
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

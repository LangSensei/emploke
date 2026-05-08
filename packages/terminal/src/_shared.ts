import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import type { LaunchCommand } from "@emploke/runtime";
import type { SpawnHandle } from "./types.js";

/** Reject paths with control characters that could break shell/AppleScript quoting. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars is the explicit purpose.
const CONTROL_CHARS_RE = /[\x00-\x1f]/;

export function validateLaunchCommand(cmd: LaunchCommand): void {
  if (CONTROL_CHARS_RE.test(cmd.cwd)) {
    throw new Error("workdir contains a control character");
  }
  if (CONTROL_CHARS_RE.test(cmd.cmd)) {
    throw new Error("command contains a control character");
  }
  for (const a of cmd.args) {
    if (CONTROL_CHARS_RE.test(a)) {
      throw new Error("argument contains a control character");
    }
  }
}

/**
 * Race the spawn handle's earlyFailure signal against an observation timer.
 * Returns the failure if the child died fast, or null if it stayed alive
 * past `observationMs` (which we treat as success — the launcher kept
 * running long enough to be considered launched).
 */
export async function waitForEarlyFailure(
  handle: SpawnHandle,
  observationMs: number,
): Promise<{ reason: string } | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), observationMs);
  });
  try {
    return await Promise.race([handle.earlyFailure, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** POSIX-portable single-quote escape for shell argv. Used by macOS + Linux. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Default deps backed by node:child_process and node:fs. The returned
 * SpawnHandle.earlyFailure resolves to a non-null reason if the child emits
 * `error` (e.g. ENOENT) or exits with a non-zero code; otherwise it stays
 * pending forever and the observation timer wins.
 */
export function realSpawn(
  file: string,
  args: readonly string[],
  opts: { cwd?: string },
): SpawnHandle {
  let child: ChildProcess;
  try {
    child = nodeSpawn(file, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { earlyFailure: Promise.resolve({ reason }) };
  }
  const earlyFailure: Promise<{ reason: string } | null> = new Promise((resolve) => {
    child.once("error", (err) => {
      resolve({ reason: err instanceof Error ? err.message : String(err) });
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        resolve({ reason: `process exited with code ${code}` });
      }
      // exit 0 in observation window means the launcher itself returned
      // (e.g. wt.exe forks and exits, which is fine). Don't treat as failure.
    });
  });
  if (typeof child.unref === "function") child.unref();
  return { earlyFailure };
}

/**
 * Robust file-presence check that handles Windows App Execution Aliases.
 *
 * `wt.exe` (and other `WindowsApps\*.exe` entries) are 0-byte files with the
 * `IO_REPARSE_TAG_APPEXECLINK` reparse tag — the kernel intercepts CreateProcess
 * to launch the real binary, but plain `stat()` fails because there is no real
 * file behind the reparse point. `fs.existsSync` follows the reparse point and
 * reports `false` for these aliases, which would make us skip wt entirely and
 * fall through to cmd even when Windows Terminal is installed.
 *
 * `lstatSync` returns the reparse point's own metadata without following, so
 * it correctly reports "exists" for App Execution Aliases.
 */
export function existsLike(p: string): boolean {
  try {
    return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return existsSync(p);
  }
}

/** Best-effort PATH lookup using existsSync over PATH directories. */
export function whichSyncDefault(name: string): string | null {
  const PATH = process.env.PATH ?? "";
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, ext ? name + ext.toLowerCase() : name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

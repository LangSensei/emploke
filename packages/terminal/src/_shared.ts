import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import type { LaunchCommand } from "@emploke/runtime";
import type { SpawnHandle, SpawnOpts } from "./types.js";

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
 * `cmd.exe` shell metacharacters that must not be allowed to reach cmd.exe's
 * shell parser unescaped. `%` and `!` (with delayed expansion) trigger
 * variable substitution even inside double-quoted strings; the rest break
 * out of the intended argument when a value is unquoted on the cmd.exe
 * command line. `"` is included because we wrap each token in `"…"` and
 * an embedded `"` would prematurely close the quoted region.
 */
const CMD_META_RE = /["%&|<>^!()]/g;

/**
 * Escape an argument that will be passed inside a `cmd.exe /c …` command
 * line built with `windowsVerbatimArguments: true`.
 *
 * Strategy: wrap the value in double quotes (so spaces, `&`, `|`, `<`, `>`,
 * `^`, `(`, `)` lose their shell meaning) and prefix every metacharacter —
 * including the few that remain dangerous inside double quotes (`%`, `!`) —
 * with `^`. Embedded `"` becomes `^"` so it survives cmd.exe's parser as a
 * literal quote rather than terminating the quoted region.
 *
 * This must be paired with `windowsVerbatimArguments: true` on the spawn
 * call: that flag tells libuv to skip its own MSVCRT-style escaping, which
 * would otherwise mangle the carets/quotes we just added.
 */
export function escapeCmdArg(s: string): string {
  return `"${s.replace(CMD_META_RE, "^$&")}"`;
}

/**
 * Default deps backed by node:child_process and node:fs. The returned
 * SpawnHandle.earlyFailure resolves to a non-null reason if the child emits
 * `error` (e.g. ENOENT) or exits with a non-zero code; otherwise it stays
 * pending forever and the observation timer wins.
 */
export function realSpawn(file: string, args: readonly string[], opts: SpawnOpts): SpawnHandle {
  let child: ChildProcess;
  try {
    child = nodeSpawn(file, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: opts.windowsVerbatimArguments,
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

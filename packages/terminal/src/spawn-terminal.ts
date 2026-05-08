import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { LaunchCommand } from "@emploke/runtime";

/**
 * Cross-platform "open a new terminal window and run this command in this
 * cwd" helper. Used by the dashboard's one-click launch — instead of asking
 * the user to copy a `cd ... && copilot` incantation into their shell,
 * the server spawns the user's terminal directly.
 *
 * Designed to be testable: the real `spawnTerminal` is a thin wrapper around
 * `spawnTerminalWith(cmd, deps)`, where deps abstract platform detection and
 * spawn so unit tests can drive every code path without touching the host.
 */

export type Launcher =
  | "wt"
  | "cmd"
  | "Terminal"
  | "gnome-terminal"
  | "kgx"
  | "konsole"
  | "xfce4-terminal"
  | "mate-terminal"
  | "tilix"
  | "wezterm"
  | "alacritty"
  | "kitty"
  | "lxterminal"
  | "xterm"
  | "x-terminal-emulator";

export interface SpawnTerminalResult {
  launcher: Launcher;
}

export class NoTerminalFoundError extends Error {
  override readonly name = "NoTerminalFoundError";
  constructor() {
    super("No supported terminal emulator was found on this system.");
  }
}

export class TerminalSpawnFailedError extends Error {
  override readonly name = "TerminalSpawnFailedError";
  constructor(
    public readonly launcher: Launcher,
    public readonly reason: string,
  ) {
    super(`Failed to launch ${launcher}: ${reason}`);
  }
}

export class UnsupportedPlatformError extends Error {
  override readonly name = "UnsupportedPlatformError";
  constructor(public readonly platform: string) {
    super(`Unsupported platform for terminal launch: ${platform}`);
  }
}

/** Reject paths with control characters that could break shell/AppleScript quoting. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars is the explicit purpose.
const CONTROL_CHARS_RE = /[\x00-\x1f]/;

// ─── Dependency-injected version (for tests) ────────────────────

export interface SpawnHandle {
  /** Resolves on early failure (process emits "error" or non-zero exit). */
  earlyFailure: Promise<{ reason: string } | null>;
}

export interface SpawnTerminalDeps {
  spawn: (file: string, args: readonly string[], opts: { cwd?: string }) => SpawnHandle;
  exists: (p: string) => boolean;
  whichSync: (name: string) => string | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Time to wait after spawning to surface immediate failures (ms). */
  observationMs: number;
}

/**
 * Linux terminal candidates in order of preference. `x-terminal-emulator` is
 * intentionally last because on Debian/Ubuntu it points to whatever the user
 * picked (xterm, lxterminal, etc.) and has no portable arg convention; we
 * only fall back to it with a generic shell wrapper.
 */
const LINUX_CANDIDATES: Launcher[] = [
  "gnome-terminal",
  "kgx",
  "konsole",
  "xfce4-terminal",
  "mate-terminal",
  "tilix",
  "wezterm",
  "alacritty",
  "kitty",
  "lxterminal",
  "xterm",
  "x-terminal-emulator",
];

export async function spawnTerminalWith(
  cmd: LaunchCommand,
  deps: SpawnTerminalDeps,
): Promise<SpawnTerminalResult> {
  validateLaunchCommand(cmd);
  switch (deps.platform) {
    case "win32":
      return await spawnWindows(cmd, deps);
    case "darwin":
      return await spawnMacOS(cmd, deps);
    case "linux":
      return await spawnLinux(cmd, deps);
    default:
      throw new UnsupportedPlatformError(deps.platform);
  }
}

function validateLaunchCommand(cmd: LaunchCommand): void {
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

async function spawnWindows(
  cmd: LaunchCommand,
  deps: SpawnTerminalDeps,
): Promise<SpawnTerminalResult> {
  // Try Windows Terminal (wt.exe) first. The WindowsApps stub is unreliable
  // on Win10 (can redirect to Microsoft Store), so we attempt to spawn it
  // and watch for an immediate error/exit. If wt fails fast we fall through
  // to the cmd.exe fallback.
  const local = deps.env.LOCALAPPDATA;
  const wtPath = local ? path.win32.join(local, "Microsoft", "WindowsApps", "wt.exe") : null;
  if (wtPath && deps.exists(wtPath)) {
    const handle = deps.spawn("wt.exe", ["-d", cmd.cwd, cmd.cmd, ...cmd.args], {});
    const failure = await waitForEarlyFailure(handle, deps.observationMs);
    if (failure === null) return { launcher: "wt" };
    // Otherwise: wt didn't actually launch (Win10 stub, missing app) — try cmd.
  }

  // Fallback: open a new cmd.exe window in the workdir and run the command.
  // `start "" /D <cwd> cmd.exe /k <cmd> <args...>` — /D is the documented way
  // to set the new console's cwd. The empty "" is start's window-title arg
  // (mandatory since "start" interprets a quoted first token as a title).
  const handle = deps.spawn(
    "cmd.exe",
    ["/c", "start", "", "/D", cmd.cwd, "cmd.exe", "/k", cmd.cmd, ...cmd.args],
    {},
  );
  const failure = await waitForEarlyFailure(handle, deps.observationMs);
  if (failure !== null) throw new TerminalSpawnFailedError("cmd", failure.reason);
  return { launcher: "cmd" };
}

async function spawnMacOS(
  cmd: LaunchCommand,
  deps: SpawnTerminalDeps,
): Promise<SpawnTerminalResult> {
  // We build a shell command that AppleScript hands to Terminal.app's
  // `do script`. Inside AppleScript double-quoted strings, only \ and " need
  // escaping; the inner shell quoting is single-quoted, so $/`/! are safe.
  const argv = [cmd.cmd, ...cmd.args].map(shQuote).join(" ");
  const inner = `cd ${shQuote(cmd.cwd)} && exec ${argv}`;
  const script = `tell application "Terminal" to do script "${escapeAppleScript(inner)}"`;
  const handle = deps.spawn("osascript", ["-e", script], {});
  const failure = await waitForEarlyFailure(handle, deps.observationMs);
  if (failure !== null) throw new TerminalSpawnFailedError("Terminal", failure.reason);
  return { launcher: "Terminal" };
}

async function spawnLinux(
  cmd: LaunchCommand,
  deps: SpawnTerminalDeps,
): Promise<SpawnTerminalResult> {
  for (const t of LINUX_CANDIDATES) {
    const found = deps.whichSync(t);
    if (!found) continue;
    const args = buildLinuxArgs(t, cmd);
    const handle = deps.spawn(found, args, {});
    const failure = await waitForEarlyFailure(handle, deps.observationMs);
    if (failure === null) return { launcher: t };
    // If the first candidate fails early (rare — usually an arg mismatch),
    // try the next one rather than giving up.
  }
  throw new NoTerminalFoundError();
}

function buildLinuxArgs(term: Launcher, cmd: LaunchCommand): string[] {
  // For each terminal, prefer the form that takes argv directly (no shell
  // parsing) when supported. Fall back to `sh -lc` for the ones whose
  // working-dir/command flags only accept a string.
  const argv = [cmd.cmd, ...cmd.args];
  const shellLine = `cd ${shQuote(cmd.cwd)} && exec ${argv.map(shQuote).join(" ")}`;
  switch (term) {
    case "gnome-terminal":
    case "mate-terminal":
    case "tilix":
      return [`--working-directory=${cmd.cwd}`, "--", ...argv];
    case "kgx":
      return ["--working-directory", cmd.cwd, "--", ...argv];
    case "konsole":
      return ["--workdir", cmd.cwd, "-e", ...argv];
    case "xfce4-terminal":
      return [`--working-directory=${cmd.cwd}`, `--command=${argv.map(shQuote).join(" ")}`];
    case "alacritty":
    case "wezterm":
      return ["--working-directory", cmd.cwd, "-e", ...argv];
    case "kitty":
      return ["--directory", cmd.cwd, ...argv];
    case "lxterminal":
      return [`--working-directory=${cmd.cwd}`, `--command=${argv.map(shQuote).join(" ")}`];
    case "xterm":
    case "x-terminal-emulator":
      // Conservative: use sh -lc so the command runs in the requested cwd
      // regardless of which terminal x-terminal-emulator points to.
      return ["-e", "sh", "-lc", shellLine];
    default:
      return ["-e", ...argv];
  }
}

async function waitForEarlyFailure(
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

function shQuote(s: string): string {
  // POSIX-portable single-quote escape.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─── Production wrapper ─────────────────────────────────────────

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
    // spawn() can throw synchronously on truly invalid args; treat as failure.
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
  // Detach so the parent can exit independently.
  if (typeof child.unref === "function") child.unref();
  return { earlyFailure };
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

const DEFAULT_DEPS: SpawnTerminalDeps = {
  spawn: realSpawn,
  exists: existsSync,
  whichSync: whichSyncDefault,
  platform: process.platform,
  env: process.env,
  observationMs: 350,
};

/** Production entry point — spawns a terminal for the given launch command. */
export function spawnTerminal(
  cmd: LaunchCommand,
  overrides?: Partial<SpawnTerminalDeps>,
): Promise<SpawnTerminalResult> {
  const deps: SpawnTerminalDeps = { ...DEFAULT_DEPS, ...overrides };
  return spawnTerminalWith(cmd, deps);
}

import path from "node:path";
import type { LaunchCommand } from "@emploke/runtime";
import { escapeCmdArg, pwshQuote, waitForEarlyFailure } from "../_shared.js";
import { TerminalSpawnFailedError } from "../errors.js";
import type { SpawnTerminalDeps, SpawnTerminalResult } from "../types.js";

/**
 * Windows: try Windows Terminal (`wt.exe`) first, fall back to `cmd.exe`.
 *
 * The WindowsApps stub for wt.exe is unreliable on Win10 (can redirect to
 * Microsoft Store), so we attempt to spawn it and watch for an immediate
 * error/exit. If wt fails fast we fall through to the cmd.exe fallback.
 *
 * `path.win32.join` (not `path.join`) is required because tests inject
 * `platform: "win32"` while running on Linux/macOS CI runners — host-relative
 * path.join would mix separators and miss the WindowsApps stub.
 *
 * NOTE: the `exists` check must handle App Execution Aliases (0-byte reparse
 * points with tag `IO_REPARSE_TAG_APPEXECLINK`). `fs.existsSync` follows the
 * reparse point and returns false for these — that bug previously made the wt
 * branch unreachable in production. Default deps now use `lstatSync` via
 * `existsLike` (see `_shared.ts`); test deps inject `filesTable` directly.
 *
 * SHELL HOSTING: the launched program (`copilot`) is wrapped in a PowerShell
 * `-NoLogo -NoExit -Command "& '<cmd>' '<arg>' …"` envelope rather than
 * being spawned directly as wt's command. Two reasons:
 *
 *   1. Copilot CLI's TUI renderer occasionally crashes with "Cannot read
 *      properties of undefined (reading 'forEach')" when wt spawns it as
 *      the immediate child — likely a ConPTY size-detection race that
 *      doesn't happen when a shell sits between wt and copilot. Hosting
 *      via pwsh matches the manual-launch path that users are known to
 *      run successfully.
 *
 *   2. `-NoExit` keeps the window open after copilot terminates, so the
 *      user can read exit messages and re-run without losing the tab.
 *
 * `pwsh.exe` is preferred (PowerShell 7+, Windows Terminal default
 * profile); we fall back to `powershell.exe` (Windows PowerShell 5,
 * always present on Windows ≥ 7) if pwsh isn't on PATH. If neither is
 * available the wt branch spawns copilot directly — better than
 * silently failing, even if the renderer race may then surface.
 */
export async function spawnWindows(
  cmd: LaunchCommand,
  deps: SpawnTerminalDeps,
): Promise<SpawnTerminalResult> {
  const local = deps.env.LOCALAPPDATA;
  const wtPath = local ? path.win32.join(local, "Microsoft", "WindowsApps", "wt.exe") : null;
  if (wtPath && deps.exists(wtPath)) {
    const wtArgs = buildWtArgs(cmd, deps);
    const handle = deps.spawn("wt.exe", wtArgs, {});
    const failure = await waitForEarlyFailure(handle, deps.observationMs);
    if (failure === null) return { launcher: "wt" };
    // Otherwise: wt didn't actually launch (Win10 stub, missing app) — try cmd.
  }

  // `start "" /D <cwd> cmd.exe /k <cmd> <args...>` — /D is the documented way
  // to set the new console's cwd. The empty "" is start's window-title arg
  // (mandatory since "start" interprets a quoted first token as a title).
  //
  // Every value forwarded through `cmd.exe /c` is quoted+escaped via
  // `escapeCmdArg` and we set `windowsVerbatimArguments: true` so libuv
  // does not double-escape: the result is that shell metacharacters in
  // `cmd.cwd` / `cmd.cmd` / `cmd.args` (e.g. `&`, `|`, `>`, `%`) cannot
  // break out of their argument and execute additional commands.
  const handle = deps.spawn(
    "cmd.exe",
    [
      "/c",
      "start",
      '""',
      "/D",
      escapeCmdArg(cmd.cwd),
      "cmd.exe",
      "/k",
      escapeCmdArg(cmd.cmd),
      ...cmd.args.map(escapeCmdArg),
    ],
    { windowsVerbatimArguments: true },
  );
  const failure = await waitForEarlyFailure(handle, deps.observationMs);
  if (failure !== null) throw new TerminalSpawnFailedError("cmd", failure.reason);
  return { launcher: "cmd" };
}

/**
 * Compose the argv we pass to `wt.exe`. Picks the best available shell
 * host (pwsh → powershell → none) and wraps the LaunchCommand so wt opens
 * a tab in that host with the command pre-running.
 *
 * When neither pwsh nor powershell is on PATH we fall through to the
 * legacy "wt runs copilot directly" form. This preserves the prior
 * behaviour rather than failing the launch — the renderer race is
 * intermittent, not deterministic.
 */
function buildWtArgs(cmd: LaunchCommand, deps: SpawnTerminalDeps): string[] {
  // Prefer pwsh 7+ since copilot CLI itself documents it as required on
  // Windows. powershell.exe (5.1) is the always-present fallback.
  const shell = deps.whichSync("pwsh") ?? deps.whichSync("powershell");
  if (shell === null) {
    return ["-d", cmd.cwd, cmd.cmd, ...cmd.args];
  }
  // Build the pwsh -Command payload using the call operator (`&`) plus
  // single-quoted argv tokens. pwsh single-quoted strings have exactly
  // one escape rule (`''` for a literal `'`) so this is robust against
  // any character in cmd.cmd / cmd.args, including spaces, `;`, `$`,
  // `&`, etc.
  const pwshCommand = ["&", pwshQuote(cmd.cmd), ...cmd.args.map(pwshQuote)].join(" ");
  return ["-d", cmd.cwd, shell, "-NoLogo", "-NoExit", "-Command", pwshCommand];
}

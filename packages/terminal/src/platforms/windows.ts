import path from "node:path";
import type { LaunchCommand } from "@emploke/runtime";
import { waitForEarlyFailure } from "../_shared.js";
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
 */
export async function spawnWindows(
  cmd: LaunchCommand,
  deps: SpawnTerminalDeps,
): Promise<SpawnTerminalResult> {
  const local = deps.env.LOCALAPPDATA;
  const wtPath = local ? path.win32.join(local, "Microsoft", "WindowsApps", "wt.exe") : null;
  if (wtPath && deps.exists(wtPath)) {
    const handle = deps.spawn("wt.exe", ["-d", cmd.cwd, cmd.cmd, ...cmd.args], {});
    const failure = await waitForEarlyFailure(handle, deps.observationMs);
    if (failure === null) return { launcher: "wt" };
    // Otherwise: wt didn't actually launch (Win10 stub, missing app) — try cmd.
  }

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

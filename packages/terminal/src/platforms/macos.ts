import { shExportPrefix, shQuote, waitForEarlyFailure } from "../_shared.js";
import { TerminalSpawnFailedError } from "../errors.js";
import type { LaunchCommand, SpawnTerminalDeps, SpawnTerminalResult } from "../types.js";

/**
 * macOS: hand the command to Terminal.app via osascript's `do script`.
 *
 * Inside AppleScript double-quoted strings, only `\` and `"` need escaping;
 * the inner shell quoting is single-quoted, so $/`/! are safe inside it.
 *
 * Env injection: Terminal.app is a long-running daemon that ignores the
 * env we hand to osascript — its child shell inherits env from launchd,
 * not from us. To reliably propagate the per-session env bag we INLINE
 * an `export K='v' && ` prefix into the shell line before `cd`+`exec`.
 * The shell sets these vars before exec'ing `copilot`, so the bag
 * lands inside copilot's `process.env` regardless of how Terminal.app
 * was launched.
 */
export async function spawnMacOS(
  cmd: LaunchCommand,
  deps: SpawnTerminalDeps,
): Promise<SpawnTerminalResult> {
  const argv = [cmd.cmd, ...cmd.args].map(shQuote).join(" ");
  const inner = `${shExportPrefix(cmd.env)}cd ${shQuote(cmd.cwd)} && exec ${argv}`;
  const script = `tell application "Terminal" to do script "${escapeAppleScript(inner)}"`;
  const handle = deps.spawn("osascript", ["-e", script], {});
  const failure = await waitForEarlyFailure(handle, deps.observationMs);
  if (failure !== null) throw new TerminalSpawnFailedError("Terminal", failure.reason);
  return { launcher: "Terminal" };
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

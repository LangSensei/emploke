import type { LaunchCommand } from "@emploke/runtime";
import { shQuote, waitForEarlyFailure } from "../_shared.js";
import { NoTerminalFoundError } from "../errors.js";
import type { Launcher, SpawnTerminalDeps, SpawnTerminalResult } from "../types.js";

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

/**
 * Linux: walk the preference list, picking the first terminal found on PATH.
 * If a candidate spawns but dies fast (rare — usually an arg mismatch), we
 * try the next one rather than giving up.
 */
export async function spawnLinux(
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
  }
  throw new NoTerminalFoundError();
}

/**
 * For each terminal, prefer the form that takes argv directly (no shell
 * parsing) when supported. Fall back to `sh -lc` for the ones whose
 * working-dir/command flags only accept a string.
 */
function buildLinuxArgs(term: Launcher, cmd: LaunchCommand): string[] {
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

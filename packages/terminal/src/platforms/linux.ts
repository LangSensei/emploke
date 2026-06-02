import { shExportPrefix, shQuote, waitForEarlyFailure } from "../_shared.js";
import { NoTerminalFoundError } from "../errors.js";
import type { LaunchCommand, Launcher, SpawnTerminalDeps, SpawnTerminalResult } from "../types.js";

/**
 * The subset of `Launcher` that names a Linux terminal emulator. Used to
 * make `LINUX_CANDIDATES` and `buildLinuxArgs` precise enough that
 * TypeScript can verify the per-terminal switches are exhaustive — any
 * future entry added to `LINUX_CANDIDATES` must also gain a switch arm
 * or the build will fail rather than silently fall through to a
 * cwd-dropping fallback.
 */
type LinuxLauncher = Extract<
  Launcher,
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
  | "x-terminal-emulator"
>;

/**
 * Linux terminal candidates in order of preference. `x-terminal-emulator` is
 * intentionally last because on Debian/Ubuntu it points to whatever the user
 * picked (xterm, lxterminal, etc.) and has no portable arg convention; we
 * only fall back to it with a generic shell wrapper.
 */
const LINUX_CANDIDATES: LinuxLauncher[] = [
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
 *
 * Env injection: when `cmd.env` is set, ALL terminals are routed through
 * the `sh -lc "<inline export + cd + exec>"` form. The native argv
 * forms (e.g. gnome-terminal `-- argv`) cannot carry env — gnome-terminal
 * is a daemon that inherits env from its first invocation, not from
 * subsequent client launches. The shell line is the only mechanism
 * that reliably sets env at the moment the actual command exec's.
 * See `shExportPrefix` for the rationale.
 */
function buildLinuxArgs(term: LinuxLauncher, cmd: LaunchCommand): string[] {
  const argv = [cmd.cmd, ...cmd.args];
  // Single canonical shell line used by every "fallback to sh -lc"
  // branch below AND by the env-set route. The export prefix is empty
  // when env is unset, so the line collapses to a plain
  // `cd <cwd> && exec <argv>`.
  const shellLine = `${shExportPrefix(cmd.env)}cd ${shQuote(cmd.cwd)} && exec ${argv.map(shQuote).join(" ")}`;

  // When env is non-empty we MUST go through a shell to materialise it.
  // Drop the per-terminal native-argv branches in that case — they
  // would silently not set the env.
  const hasEnv = cmd.env !== undefined && Object.keys(cmd.env).length > 0;
  if (hasEnv) {
    switch (term) {
      case "xfce4-terminal":
      case "lxterminal":
        // Both accept --command=<single string>. Compose the sh -lc
        // call as a single string and let the terminal hand it to its
        // default shell (which then runs sh -lc).
        return [`--working-directory=${cmd.cwd}`, `--command=sh -lc ${shQuote(shellLine)}`];
      case "gnome-terminal":
      case "mate-terminal":
      case "tilix":
        return [`--working-directory=${cmd.cwd}`, "--", "sh", "-lc", shellLine];
      case "kgx":
        return ["--working-directory", cmd.cwd, "--", "sh", "-lc", shellLine];
      case "konsole":
        return ["--workdir", cmd.cwd, "-e", "sh", "-lc", shellLine];
      case "alacritty":
      case "wezterm":
        return ["--working-directory", cmd.cwd, "-e", "sh", "-lc", shellLine];
      case "kitty":
        return ["--directory", cmd.cwd, "sh", "-lc", shellLine];
      case "xterm":
      case "x-terminal-emulator":
        return ["-e", "sh", "-lc", shellLine];
    }
  }

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
  }
}

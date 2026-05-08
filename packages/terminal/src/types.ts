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

export interface SpawnHandle {
  /** Resolves on early failure (process emits "error" or non-zero exit). */
  earlyFailure: Promise<{ reason: string } | null>;
}

export interface SpawnOpts {
  cwd?: string;
  /**
   * Windows-only: when true, libuv passes `args` to CreateProcessW with NO
   * MSVCRT-style escaping/quoting — args are joined verbatim with single
   * spaces. Used by the cmd.exe fallback so that we control cmd.exe's shell
   * parsing entirely (preventing shell-metachar injection in cwd/args).
   */
  windowsVerbatimArguments?: boolean;
}

export interface SpawnTerminalDeps {
  spawn: (file: string, args: readonly string[], opts: SpawnOpts) => SpawnHandle;
  exists: (p: string) => boolean;
  whichSync: (name: string) => string | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Time to wait after spawning to surface immediate failures (ms). */
  observationMs: number;
}

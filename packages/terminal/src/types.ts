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

/**
 * Shell-runnable launch command, as the terminal package needs it.
 *
 * **Consumer port.** Terminal defines the shape it needs to spawn a
 * process into a platform terminal emulator. Producers — currently
 * `@emploke/runtime`'s `Runtime.buildInteractiveLaunch` — own their
 * own definition; the wiring relies on TypeScript's structural
 * typing to confirm compatibility at the call sites. Keeping this
 * type local removes terminal's workspace dep on any specific
 * producer pkg and makes terminal a pure infrastructure leaf
 * consumable by anything that can produce a command of this shape.
 *
 * As of issue #276, the primary consumer is
 * `SessionService.spawnInteractive` (in `@emploke/session`), which
 * receives `spawnTerminal` via a `SpawnFn` port injected by
 * `@emploke/api`'s `composeApplication`. `@emploke/session` deliberately
 * does NOT import `@emploke/terminal` at all (neither value nor
 * type); `SpawnFn`'s structural shape
 * (`(cmd: LaunchCommand) => Promise<{ launcher: string }>`) is what
 * holds the two together, with `spawnTerminal`'s return type
 * (`SpawnTerminalResult = { launcher: Launcher }`) satisfying it
 * via covariance (`Launcher` is a `string` subtype). The "consumable
 * by anything" framing therefore remains realised, not aspirational.
 *
 * The `cmd`/`args`/`cwd` triple is suitable for `child_process.spawn`;
 * `display` is a single-line string suitable for showing to the user
 * or copying to the clipboard.
 */
export interface LaunchCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
  /**
   * Optional env vars the spawned terminal session should inherit.
   *
   * Most platform terminal emulators (Windows Terminal, Terminal.app,
   * gnome-terminal, …) run as long-lived daemons that do NOT see the
   * env handed to the launcher process. Reliably propagating env to
   * the shell that ends up exec'ing this command therefore requires
   * INLINING the env into the shell command itself (`export K='v' &&
   * exec foo args` on POSIX, `$env:K='v'; & foo args` for pwsh).
   * This package does that work; see the per-platform impls in
   * `src/platforms/`.
   *
   * Values must be plain strings — no `undefined` (semantically
   * meaningless when inlining), no `null`, no arrays. `undefined`
   * upstream should be filtered before assembling this map.
   */
  readonly env?: Readonly<Record<string, string>>;
}

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
  /**
   * Resolves to `{ reason }` if the child emits `error` (e.g. ENOENT)
   * or exits with a non-zero code before the caller's observation
   * window elapses. In the happy path the promise stays pending —
   * the caller is expected to race it against an observation timer
   * (see `waitForEarlyFailure`). The `null` arm of the union exists
   * so that the post-race result can share this type; no producer in
   * this package resolves the promise with `null` directly.
   */
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
  /**
   * Optional env override. When undefined, the child inherits the
   * parent's `process.env` (Node default). When set, `realSpawn`
   * passes it as-is to `child_process.spawn`'s `env` option — the
   * caller is responsible for merging with `process.env` if they
   * want partial-override semantics.
   *
   * Used as a belt-and-suspenders for the Windows `cmd /k` fallback,
   * where the new console naturally inherits parent env. The wt+pwsh
   * and macOS/Linux paths inline env into the shell command instead
   * (because their target apps run as daemons and ignore spawn env);
   * see the per-platform impls.
   */
  env?: NodeJS.ProcessEnv;
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

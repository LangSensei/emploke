# @emploke/terminal

Host a shell-runnable `LaunchCommand` inside a per-platform terminal
emulator. Used by emploke's one-click launch — instead of asking the
user to copy a `cd … && copilot …` incantation into their shell, the
server spawns the user's terminal directly with the command pre-running
in the requested workdir.

## Consumer port

`LaunchCommand` is defined in this package and is duck-typed against
whatever the producer hands to `spawnTerminal`. The current producer is
`@emploke/runtime`'s `Runtime.buildInteractiveLaunch`, but anything
structurally compatible works — the wiring relies on TypeScript's
structural typing at the call site rather than a workspace dep on a
specific producer package. Keeping the type local makes terminal a
pure infrastructure leaf consumable by any caller that can produce a
command of this shape.

```ts
interface LaunchCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly display: string;
  readonly env?: Readonly<Record<string, string>>;
}
```

## Supported launchers

| Platform | Preferred                                    | Fallback                |
| -------- | -------------------------------------------- | ----------------------- |
| Windows  | `wt.exe` hosted in `pwsh` / `powershell`     | `cmd.exe /k`            |
| macOS    | `Terminal.app` via `osascript "do script …"` | —                       |
| Linux    | `gnome-terminal`, `kgx`, `konsole`, `xfce4-terminal`, `mate-terminal`, `tilix`, `wezterm`, `alacritty`, `kitty`, `lxterminal`, `xterm` | `x-terminal-emulator` |

The Linux candidates are tried in the order listed above; the first
one found on `PATH` wins. `x-terminal-emulator` is intentionally last
because on Debian/Ubuntu it points to whatever the user picked and has
no portable arg convention.

## Env-propagation guarantees

When `LaunchCommand.env` is non-empty, the package guarantees the vars
reach the spawned command's `process.env` — but the mechanism differs
per platform because most terminal apps run as long-lived daemons that
ignore env handed to their launcher process:

- **macOS (`Terminal.app`)** — env is inlined as `export K='v' && ` in
  the shell line passed to `osascript "do script …"`. Terminal.app's
  daemon ignores osascript-time env; the inline prefix runs in the
  child shell that ends up exec'ing the command.
- **Linux (every emulator)** — when env is set, all candidates are
  routed through `sh -lc "<export … && cd … && exec …>"`. The native
  argv forms (`gnome-terminal -- argv`, etc.) cannot carry env because
  the emulator daemon inherits env from its first invocation, not from
  subsequent client launches.
- **Windows (`wt.exe` + pwsh)** — env is inlined as
  `$env:K = 'v'; …; & 'cmd' 'args'` inside the `pwsh -Command` payload.
  `wt.exe` runs as a daemon, so spawn-time env doesn't reach new tabs,
  but the pwsh we host inside the new tab is in our control.
  Semicolons in the payload are escaped as `\;` because `wt.exe`
  treats `;` as a command separator across the whole command line.
- **Windows (`cmd.exe` fallback)** — env is propagated via the spawn
  `env` option. `cmd /k` reliably inherits env from its parent, so no
  inline `set` prefix is needed.

Values must be plain strings — `undefined` and `null` entries are
filtered out defensively before quoting.

## API

```ts
import { spawnTerminal, type LaunchCommand } from "@emploke/terminal";

const cmd: LaunchCommand = {
  cmd: "copilot",
  args: ["--session-id=…"],
  cwd: "/path/to/workspace",
  display: "cd '/path/to/workspace' && copilot --session-id=…",
  env: { EMPLOKE_WORKSPACE: "ws-uuid" },
};

const result = await spawnTerminal(cmd); // { launcher: "wt" | "cmd" | ... }
```

`spawnTerminalWith(cmd, deps)` is the dependency-injected variant used
by tests. `spawnTerminal` fills in real `node:child_process` /
`node:fs` deps and forwards.

Errors: `NoTerminalFoundError`, `TerminalSpawnFailedError`,
`UnsupportedPlatformError` — all named subclasses of `Error`.

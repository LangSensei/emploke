// Public surface for @emploke/terminal — host a LaunchCommand in a terminal.

export { whichSyncDefault } from "./_shared.js";
export { spawnTerminal, spawnTerminalWith } from "./dispatch.js";
export {
  NoTerminalFoundError,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
} from "./errors.js";
export type {
  LaunchCommand,
  Launcher,
  SpawnHandle,
  SpawnTerminalDeps,
  SpawnTerminalResult,
} from "./types.js";

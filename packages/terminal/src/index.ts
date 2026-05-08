// Public surface for @emploke/terminal — host a LaunchCommand in a terminal.
export {
  type Launcher,
  NoTerminalFoundError,
  type SpawnHandle,
  type SpawnTerminalDeps,
  type SpawnTerminalResult,
  spawnTerminal,
  spawnTerminalWith,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
  whichSyncDefault,
} from "./spawn-terminal.js";

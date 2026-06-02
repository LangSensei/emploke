import { existsLike, realSpawn, validateLaunchCommand, whichSyncDefault } from "./_shared.js";
import { UnsupportedPlatformError } from "./errors.js";
import { spawnLinux } from "./platforms/linux.js";
import { spawnMacOS } from "./platforms/macos.js";
import { spawnWindows } from "./platforms/windows.js";
import type { LaunchCommand, SpawnTerminalDeps, SpawnTerminalResult } from "./types.js";

/**
 * Dependency-injected dispatch entry. Used directly by tests to drive any
 * platform branch without touching the host. Production code calls
 * `spawnTerminal` instead, which fills in the real `node:child_process`
 * and `node:fs` deps.
 */
export async function spawnTerminalWith(
  cmd: LaunchCommand,
  deps: SpawnTerminalDeps,
): Promise<SpawnTerminalResult> {
  validateLaunchCommand(cmd);
  switch (deps.platform) {
    case "win32":
      return await spawnWindows(cmd, deps);
    case "darwin":
      return await spawnMacOS(cmd, deps);
    case "linux":
      return await spawnLinux(cmd, deps);
    default:
      throw new UnsupportedPlatformError(deps.platform);
  }
}

const DEFAULT_DEPS: SpawnTerminalDeps = {
  spawn: realSpawn,
  exists: existsLike,
  whichSync: whichSyncDefault,
  platform: process.platform,
  env: process.env,
  observationMs: 350,
};

/** Production entry point — spawns a terminal for the given launch command. */
export function spawnTerminal(
  cmd: LaunchCommand,
  overrides?: Partial<SpawnTerminalDeps>,
): Promise<SpawnTerminalResult> {
  const deps: SpawnTerminalDeps = { ...DEFAULT_DEPS, ...overrides };
  return spawnTerminalWith(cmd, deps);
}

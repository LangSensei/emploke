import type { LaunchCommand } from "@emploke/runtime";
import type { SpawnHandle, SpawnTerminalDeps } from "../src/index.js";

export const sample: LaunchCommand = {
  cmd: "copilot",
  args: [],
  cwd: "/tmp/wd",
  display: 'cd "/tmp/wd" && copilot',
};

export const sampleResume: LaunchCommand = {
  cmd: "copilot",
  args: ["--resume=12345678-1234-1234-1234-1234567890ab"],
  cwd: "/tmp/wd",
  display: 'cd "/tmp/wd" && copilot --resume=12345678-1234-1234-1234-1234567890ab',
};

export interface SpawnCall {
  file: string;
  args: readonly string[];
  cwd: string | undefined;
  windowsVerbatimArguments: boolean | undefined;
  env: NodeJS.ProcessEnv | undefined;
}

export interface FakeOptions {
  /** If set, the i-th call's spawn handle will report this failure. */
  failures?: Record<number, string | null>;
  /** Fake `whichSync` table: name -> path or null. */
  pathTable?: Record<string, string | null>;
  /** Fake `existsSync` table. */
  filesTable?: Record<string, boolean>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function makeDeps(opts: FakeOptions): { deps: SpawnTerminalDeps; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  let i = 0;
  const deps: SpawnTerminalDeps = {
    spawn: (file, args, options): SpawnHandle => {
      const idx = i++;
      calls.push({
        file,
        args,
        cwd: options.cwd,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
        env: options.env,
      });
      const failure = opts.failures?.[idx];
      return {
        earlyFailure:
          failure === undefined || failure === null
            ? new Promise(() => {
                /* never resolves */
              })
            : Promise.resolve({ reason: failure }),
      };
    },
    exists: (p) => opts.filesTable?.[p] ?? false,
    whichSync: (name) => opts.pathTable?.[name] ?? null,
    platform: opts.platform ?? "linux",
    env: opts.env ?? {},
    observationMs: 5,
  };
  return { deps, calls };
}

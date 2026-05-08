import type { LaunchCommand } from "@emploke/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  NoTerminalFoundError,
  type SpawnHandle,
  type SpawnTerminalDeps,
  spawnTerminalWith,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
} from "../src/spawn-terminal.js";

const sample: LaunchCommand = {
  cmd: "copilot",
  args: [],
  cwd: "/tmp/wd",
  display: 'cd "/tmp/wd" && copilot',
};

const sampleResume: LaunchCommand = {
  cmd: "copilot",
  args: ["--resume=12345678-1234-1234-1234-1234567890ab"],
  cwd: "/tmp/wd",
  display: 'cd "/tmp/wd" && copilot --resume=12345678-1234-1234-1234-1234567890ab',
};

interface SpawnCall {
  file: string;
  args: readonly string[];
  cwd: string | undefined;
}

interface FakeOptions {
  /** If set, the i-th call's spawn handle will report this failure. */
  failures?: Record<number, string | null>;
  /** Fake `whichSync` table: name -> path or null. */
  pathTable?: Record<string, string | null>;
  /** Fake `existsSync` table. */
  filesTable?: Record<string, boolean>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function makeDeps(opts: FakeOptions): { deps: SpawnTerminalDeps; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  let i = 0;
  const deps: SpawnTerminalDeps = {
    spawn: (file, args, options): SpawnHandle => {
      const idx = i++;
      calls.push({ file, args, cwd: options.cwd });
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

describe("spawnTerminalWith", () => {
  describe("validation", () => {
    it("rejects cwd containing a control character", async () => {
      const { deps } = makeDeps({ platform: "linux" });
      const bad: LaunchCommand = { ...sample, cwd: "/tmp/wd\nrm -rf" };
      await expect(spawnTerminalWith(bad, deps)).rejects.toThrow(/control character/);
    });

    it("rejects argument containing a control character", async () => {
      const { deps } = makeDeps({ platform: "linux" });
      const bad: LaunchCommand = { ...sample, args: ["-i\x00malicious"] };
      await expect(spawnTerminalWith(bad, deps)).rejects.toThrow(/control character/);
    });

    it("throws UnsupportedPlatformError on unknown platform", async () => {
      const { deps } = makeDeps({ platform: "freebsd" as NodeJS.Platform });
      await expect(spawnTerminalWith(sample, deps)).rejects.toThrow(UnsupportedPlatformError);
    });
  });

  describe("windows", () => {
    it("uses wt.exe when WindowsApps stub exists and launches successfully", async () => {
      const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
      const { deps, calls } = makeDeps({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        filesTable: { [wt]: true },
      });
      const cmd: LaunchCommand = { ...sample, cwd: "C:\\work\\session" };
      const result = await spawnTerminalWith(cmd, deps);
      expect(result.launcher).toBe("wt");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe("wt.exe");
      expect(calls[0]?.args).toEqual(["-d", "C:\\work\\session", "copilot"]);
    });

    it("falls back to cmd when wt fails immediately", async () => {
      const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
      const { deps, calls } = makeDeps({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        filesTable: { [wt]: true },
        failures: { 0: "ENOENT" },
      });
      const cmd: LaunchCommand = { ...sample, cwd: "C:\\work\\session" };
      const result = await spawnTerminalWith(cmd, deps);
      expect(result.launcher).toBe("cmd");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.file).toBe("cmd.exe");
      expect(calls[1]?.args).toEqual([
        "/c",
        "start",
        "",
        "/D",
        "C:\\work\\session",
        "cmd.exe",
        "/k",
        "copilot",
      ]);
    });

    it("uses cmd when wt stub is not present at all", async () => {
      const { deps, calls } = makeDeps({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        filesTable: {}, // wt path does not exist
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("cmd");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe("cmd.exe");
    });

    it("uses cmd when LOCALAPPDATA is not set", async () => {
      const { deps, calls } = makeDeps({
        platform: "win32",
        env: {},
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("cmd");
      expect(calls).toHaveLength(1);
    });

    it("throws TerminalSpawnFailedError when cmd fallback also fails", async () => {
      const { deps } = makeDeps({
        platform: "win32",
        env: {},
        failures: { 0: "ENOENT cmd.exe" },
      });
      await expect(spawnTerminalWith(sample, deps)).rejects.toThrow(TerminalSpawnFailedError);
    });
  });

  describe("macOS", () => {
    it("uses osascript with Terminal.app and quotes paths safely", async () => {
      const { deps, calls } = makeDeps({ platform: "darwin" });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("Terminal");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe("osascript");
      expect(calls[0]?.args[0]).toBe("-e");
      const script = calls[0]?.args[1];
      expect(script).toMatch(/^tell application "Terminal" to do script /);
      // shell command should be single-quoted around the workdir
      expect(script).toContain("cd '/tmp/wd' && exec 'copilot'");
    });

    it("escapes embedded double-quotes and backslashes for AppleScript", async () => {
      const { deps, calls } = makeDeps({ platform: "darwin" });
      const cmd: LaunchCommand = { ...sample, cwd: "/tmp/has\\back\\slash" };
      await spawnTerminalWith(cmd, deps);
      const script = calls[0]?.args[1] as string;
      // The AppleScript-level escape doubles backslashes; the inner shell
      // quoting also single-quotes the path. Verify both layers happen.
      expect(script).toContain("\\\\back\\\\slash");
    });

    it("includes resume args verbatim", async () => {
      const { deps, calls } = makeDeps({ platform: "darwin" });
      await spawnTerminalWith(sampleResume, deps);
      const script = calls[0]?.args[1] as string;
      expect(script).toContain("exec 'copilot' '--resume=12345678-1234-1234-1234-1234567890ab'");
    });

    it("throws TerminalSpawnFailedError when osascript fails", async () => {
      const { deps } = makeDeps({ platform: "darwin", failures: { 0: "ENOENT" } });
      await expect(spawnTerminalWith(sample, deps)).rejects.toThrow(TerminalSpawnFailedError);
    });
  });

  describe("linux", () => {
    it("uses gnome-terminal when found", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: { "gnome-terminal": "/usr/bin/gnome-terminal" },
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("gnome-terminal");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe("/usr/bin/gnome-terminal");
      expect(calls[0]?.args).toEqual(["--working-directory=/tmp/wd", "--", "copilot"]);
    });

    it("uses konsole's --workdir / -e syntax", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: { konsole: "/usr/bin/konsole" },
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("konsole");
      expect(calls[0]?.args).toEqual(["--workdir", "/tmp/wd", "-e", "copilot"]);
    });

    it("uses kitty's --directory syntax", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: { kitty: "/usr/bin/kitty" },
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("kitty");
      expect(calls[0]?.args).toEqual(["--directory", "/tmp/wd", "copilot"]);
    });

    it("uses xfce4-terminal's quoted --command form", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: { "xfce4-terminal": "/usr/bin/xfce4-terminal" },
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("xfce4-terminal");
      expect(calls[0]?.args).toEqual(["--working-directory=/tmp/wd", "--command='copilot'"]);
    });

    it("falls back to xterm with sh -lc for portability", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: { xterm: "/usr/bin/xterm" },
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("xterm");
      expect(calls[0]?.args).toEqual(["-e", "sh", "-lc", "cd '/tmp/wd' && exec 'copilot'"]);
    });

    it("uses x-terminal-emulator with sh -lc as last resort", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: { "x-terminal-emulator": "/usr/bin/x-terminal-emulator" },
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("x-terminal-emulator");
      expect(calls[0]?.args[0]).toBe("-e");
      expect(calls[0]?.args[1]).toBe("sh");
      expect(calls[0]?.args[2]).toBe("-lc");
    });

    it("prefers gnome-terminal over xterm when both exist", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: {
          "gnome-terminal": "/usr/bin/gnome-terminal",
          xterm: "/usr/bin/xterm",
        },
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("gnome-terminal");
      expect(calls).toHaveLength(1);
    });

    it("tries the next candidate when the first fails immediately", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: {
          "gnome-terminal": "/usr/bin/gnome-terminal",
          xterm: "/usr/bin/xterm",
        },
        failures: { 0: "version mismatch" },
      });
      const result = await spawnTerminalWith(sample, deps);
      expect(result.launcher).toBe("xterm");
      expect(calls).toHaveLength(2);
    });

    it("throws NoTerminalFoundError when no candidates resolve", async () => {
      const { deps } = makeDeps({ platform: "linux", pathTable: {} });
      await expect(spawnTerminalWith(sample, deps)).rejects.toThrow(NoTerminalFoundError);
    });

    it("throws NoTerminalFoundError when every candidate fails to start", async () => {
      const { deps } = makeDeps({
        platform: "linux",
        pathTable: {
          "gnome-terminal": "/usr/bin/gnome-terminal",
          xterm: "/usr/bin/xterm",
        },
        failures: { 0: "fail", 1: "fail" },
      });
      await expect(spawnTerminalWith(sample, deps)).rejects.toThrow(NoTerminalFoundError);
    });

    it("safely quotes a workdir containing a single quote", async () => {
      const { deps, calls } = makeDeps({
        platform: "linux",
        pathTable: { xterm: "/usr/bin/xterm" },
      });
      const cmd: LaunchCommand = { ...sample, cwd: "/tmp/Lang's Files" };
      await spawnTerminalWith(cmd, deps);
      // Single quote must be escaped as '\'' inside POSIX single quotes.
      expect(calls[0]?.args[3]).toBe("cd '/tmp/Lang'\\''s Files' && exec 'copilot'");
    });
  });
});

// vi is imported but tests don't use mocks — import keeps treeshake happy.
void vi;

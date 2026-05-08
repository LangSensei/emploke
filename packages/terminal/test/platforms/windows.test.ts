import type { LaunchCommand } from "@emploke/runtime";
import { describe, expect, it } from "vitest";
import { spawnTerminalWith, TerminalSpawnFailedError } from "../../src/index.js";
import { makeDeps, sample } from "../_helpers.js";

describe("spawnTerminalWith > windows", () => {
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

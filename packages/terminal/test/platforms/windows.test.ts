import type { LaunchCommand } from "@emploke/runtime";
import { describe, expect, it } from "vitest";
import { spawnTerminalWith, TerminalSpawnFailedError } from "../../src/index.js";
import { makeDeps, sample } from "../_helpers.js";

describe("spawnTerminalWith > windows", () => {
  it("uses wt.exe with pwsh wrapper when WindowsApps stub exists and pwsh is on PATH", async () => {
    const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      filesTable: { [wt]: true },
      pathTable: { pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
    });
    const cmd: LaunchCommand = { ...sample, cwd: "C:\\work\\session" };
    const result = await spawnTerminalWith(cmd, deps);
    expect(result.launcher).toBe("wt");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("wt.exe");
    expect(calls[0]?.args).toEqual([
      "-d",
      "C:\\work\\session",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "-NoLogo",
      "-NoExit",
      "-Command",
      "& 'copilot'",
    ]);
    // wt.exe parses argv directly; no shell involved at this layer, so verbatim is off.
    expect(calls[0]?.windowsVerbatimArguments).toBeFalsy();
  });

  it("falls back to powershell.exe (Windows PowerShell 5) when pwsh is missing", async () => {
    const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      filesTable: { [wt]: true },
      pathTable: {
        pwsh: null,
        powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      },
    });
    const result = await spawnTerminalWith(sample, deps);
    expect(result.launcher).toBe("wt");
    expect(calls[0]?.args[2]).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("spawns copilot directly via wt when neither pwsh nor powershell is on PATH", async () => {
    // Belt-and-suspenders: if no shell host is available we fall back to
    // wt's "command directly" form rather than failing the launch. The TUI
    // forEach race may surface here, but a working terminal beats a hung UI.
    const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      filesTable: { [wt]: true },
      pathTable: { pwsh: null, powershell: null },
    });
    const result = await spawnTerminalWith(sample, deps);
    expect(result.launcher).toBe("wt");
    expect(calls[0]?.args).toEqual(["-d", "/tmp/wd", "copilot"]);
  });

  it("composes the pwsh -Command payload with single-quoted args via the call operator", async () => {
    const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      filesTable: { [wt]: true },
      pathTable: { pwsh: "pwsh.exe" },
    });
    const cmd: LaunchCommand = {
      ...sample,
      args: ["--resume=12345678-1234-1234-1234-1234567890ab", "--yolo"],
    };
    await spawnTerminalWith(cmd, deps);
    const payload = calls[0]?.args.at(-1);
    expect(payload).toBe("& 'copilot' '--resume=12345678-1234-1234-1234-1234567890ab' '--yolo'");
  });

  it("escapes embedded single quotes in args via the pwsh '' double rule", async () => {
    const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      filesTable: { [wt]: true },
      pathTable: { pwsh: "pwsh.exe" },
    });
    // Arbitrary arg containing the only character pwsh single quotes need
    // to escape: a literal `'`. Escape rule: `''` for one `'`.
    const cmd: LaunchCommand = { ...sample, args: ["it's-fine"] };
    await spawnTerminalWith(cmd, deps);
    const payload = calls[0]?.args.at(-1);
    expect(payload).toBe("& 'copilot' 'it''s-fine'");
  });

  it("falls back to cmd when wt fails immediately", async () => {
    const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      filesTable: { [wt]: true },
      pathTable: { pwsh: null, powershell: null },
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
      '""',
      "/D",
      '"C:\\work\\session"',
      "cmd.exe",
      "/k",
      '"copilot"',
    ]);
    expect(calls[1]?.windowsVerbatimArguments).toBe(true);
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
    expect(calls[0]?.windowsVerbatimArguments).toBe(true);
  });

  it("uses cmd when LOCALAPPDATA is not set", async () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: {},
    });
    const result = await spawnTerminalWith(sample, deps);
    expect(result.launcher).toBe("cmd");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.windowsVerbatimArguments).toBe(true);
  });

  it("throws TerminalSpawnFailedError when cmd fallback also fails", async () => {
    const { deps } = makeDeps({
      platform: "win32",
      env: {},
      failures: { 0: "ENOENT cmd.exe" },
    });
    await expect(spawnTerminalWith(sample, deps)).rejects.toThrow(TerminalSpawnFailedError);
  });

  // --- Shell-injection hardening (regression suite) ---
  //
  // These tests assert that values reaching the cmd.exe parser are quoted
  // and caret-escaped so shell metacharacters cannot break out of their
  // argument. Each test exercises a different metacharacter class:
  //   - structural separators (& | < > ^ ( ))
  //   - variable expansion (% !)
  //   - quote injection (")
  // A regression here would re-introduce the Windows shell-injection bug.

  it("escapes & in cwd so it cannot terminate the start command", async () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: {},
    });
    const evil: LaunchCommand = {
      ...sample,
      cwd: "C:\\Users\\test & calc.exe\\session",
    };
    await spawnTerminalWith(evil, deps);
    const args = calls[0]?.args ?? [];
    const cwdArg = args[4];
    expect(cwdArg).toBe('"C:\\Users\\test ^& calc.exe\\session"');
  });

  it("escapes pipe and redirection metachars in args", async () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: {},
    });
    const evil: LaunchCommand = {
      ...sample,
      args: ["a|b", "c>d", "e<f"],
    };
    await spawnTerminalWith(evil, deps);
    const args = calls[0]?.args ?? [];
    expect(args.slice(-3)).toEqual(['"a^|b"', '"c^>d"', '"e^<f"']);
  });

  it("escapes %VAR% so cmd.exe variable expansion cannot fire", async () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: {},
    });
    const evil: LaunchCommand = {
      ...sample,
      args: ["--token=%PATH%"],
    };
    await spawnTerminalWith(evil, deps);
    const args = calls[0]?.args ?? [];
    expect(args.at(-1)).toBe('"--token=^%PATH^%"');
  });

  it("escapes ! so delayed expansion (cmd.exe /v:on) cannot fire", async () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: {},
    });
    const evil: LaunchCommand = {
      ...sample,
      args: ["--note=!HOMEPATH!"],
    };
    await spawnTerminalWith(evil, deps);
    const args = calls[0]?.args ?? [];
    expect(args.at(-1)).toBe('"--note=^!HOMEPATH^!"');
  });

  it('escapes embedded " so it cannot close the quoted region early', async () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: {},
    });
    const evil: LaunchCommand = {
      ...sample,
      args: ['a"b'],
    };
    await spawnTerminalWith(evil, deps);
    const args = calls[0]?.args ?? [];
    expect(args.at(-1)).toBe('"a^"b"');
  });

  it("escapes parentheses and caret in args (FOR/IF block syntax + escape char)", async () => {
    const { deps, calls } = makeDeps({
      platform: "win32",
      env: {},
    });
    const evil: LaunchCommand = {
      ...sample,
      args: ["(a)", "x^y"],
    };
    await spawnTerminalWith(evil, deps);
    const args = calls[0]?.args ?? [];
    expect(args.slice(-2)).toEqual(['"^(a^)"', '"x^^y"']);
  });
});

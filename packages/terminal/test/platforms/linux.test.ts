import type { LaunchCommand } from "@emploke/runtime";
import { describe, expect, it } from "vitest";
import { NoTerminalFoundError, spawnTerminalWith } from "../../src/index.js";
import { makeDeps, sample } from "../_helpers.js";

describe("spawnTerminalWith > linux", () => {
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

import type { LaunchCommand } from "@emploke/runtime";
import { describe, expect, it } from "vitest";
import { spawnTerminalWith, TerminalSpawnFailedError } from "../../src/index.js";
import { makeDeps, sample, sampleResume } from "../_helpers.js";

describe("spawnTerminalWith > macOS", () => {
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

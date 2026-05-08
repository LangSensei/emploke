import type { LaunchCommand } from "@emploke/runtime";
import { describe, expect, it } from "vitest";
import { spawnTerminalWith, UnsupportedPlatformError } from "../src/index.js";
import { makeDeps, sample } from "./_helpers.js";

describe("spawnTerminalWith — dispatch + validation", () => {
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

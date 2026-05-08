import path from "node:path";
import { describe, expect, it } from "vitest";
import { type ResolveCopilotBinDeps, resolveCopilotBin } from "../../src/copilot/resolve-bin.js";

const FAKE_LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
const SHIM_DIR = path.join(FAKE_LOCALAPPDATA, "Microsoft", "WinGet", "Links");
const SHIM_PATH = path.join(SHIM_DIR, "copilot.exe");
const PACKAGES_DIR = path.join(FAKE_LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
const REAL_PACKAGE_DIR = "GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe";
const REAL_BIN = path.join(PACKAGES_DIR, REAL_PACKAGE_DIR, "copilot.exe");

function makeDeps(overrides: Partial<ResolveCopilotBinDeps> = {}): ResolveCopilotBinDeps {
  const filesystem = new Set<string>([PACKAGES_DIR, REAL_BIN]);
  return {
    platform: "win32",
    env: { LOCALAPPDATA: FAKE_LOCALAPPDATA },
    which: () => SHIM_PATH,
    exists: (p) => filesystem.has(p),
    readdir: (dir) => {
      if (dir === PACKAGES_DIR) return [REAL_PACKAGE_DIR];
      return [];
    },
    ...overrides,
  };
}

describe("resolveCopilotBin", () => {
  it("on non-windows is a pass-through", () => {
    const r = resolveCopilotBin("copilot", { platform: "linux" });
    expect(r).toEqual({ bin: "copilot", reason: "path-passthrough" });
  });

  it("redirects WinGet shim to real packaged binary on Windows", () => {
    const r = resolveCopilotBin("copilot", makeDeps());
    expect(r.bin).toBe(REAL_BIN);
    expect(r.reason).toBe("winget-package");
  });

  it("when PATH `copilot` is not the shim, still prefers WinGet package if present", () => {
    // We treat the real WinGet binary as authoritative even when PATH
    // resolves to something else; the real binary is what we know works
    // under non-console spawn.
    const elsewhere = "C:\\Tools\\copilot.exe";
    const r = resolveCopilotBin("copilot", makeDeps({ which: () => elsewhere }));
    expect(r.bin).toBe(REAL_BIN);
    expect(r.reason).toBe("winget-package");
  });

  it("when configured with an absolute non-shim path, returns it untouched", () => {
    const customBin = "C:\\custom\\copilot.exe";
    const deps = makeDeps({
      exists: () => false, // no WinGet/npm install
      readdir: () => [],
    });
    const r = resolveCopilotBin(customBin, deps);
    expect(r.bin).toBe(customBin);
    expect(r.reason).toBe("configured");
  });

  it("falls back to npm install when WinGet packages dir is empty", () => {
    const npmBin = path.join(
      "C:\\Users\\test\\AppData\\Roaming",
      "npm",
      "node_modules",
      "@github",
      "copilot",
      "node_modules",
      "@github",
      "copilot-win32-x64",
      "copilot.exe",
    );
    const filesystem = new Set<string>([npmBin]); // no WinGet, npm exists
    const r = resolveCopilotBin("copilot", {
      platform: "win32",
      env: {
        LOCALAPPDATA: FAKE_LOCALAPPDATA,
        APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      },
      which: () => SHIM_PATH,
      exists: (p) => filesystem.has(p),
      readdir: () => [],
    });
    expect(r.bin).toBe(npmBin);
    expect(r.reason).toBe("npm-package");
  });

  it("falls back to PATH hit when no WinGet/npm install found", () => {
    const r = resolveCopilotBin("copilot", {
      platform: "win32",
      env: { LOCALAPPDATA: FAKE_LOCALAPPDATA },
      which: () => SHIM_PATH,
      exists: () => false,
      readdir: () => [],
    });
    // Last resort: hand back the shim. Failure mode unchanged from baseline.
    expect(r.bin).toBe(SHIM_PATH);
    expect(r.reason).toBe("path-passthrough");
  });

  it("when `where` lookup fails, falls back to configured bin", () => {
    const r = resolveCopilotBin("copilot", {
      platform: "win32",
      env: { LOCALAPPDATA: FAKE_LOCALAPPDATA },
      which: () => null,
      exists: () => false,
      readdir: () => [],
    });
    expect(r.bin).toBe("copilot");
    expect(r.reason).toBe("path-passthrough");
  });

  it("treats explicitly-configured shim path as still-needs-redirect", () => {
    const r = resolveCopilotBin(SHIM_PATH, makeDeps());
    expect(r.bin).toBe(REAL_BIN);
    expect(r.reason).toBe("winget-package");
  });
});

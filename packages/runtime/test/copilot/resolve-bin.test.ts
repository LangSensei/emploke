import path from "node:path";
import { describe, expect, it } from "vitest";
import { type ResolveCopilotBinDeps, resolveCopilotBin } from "../../src/copilot/resolve-bin.js";

// All fixtures here describe Windows-shaped paths regardless of the host
// OS the tests are running on. Use `path.win32.join` (not the host-OS
// `path.join`) so a POSIX runner produces the same backslash-separated
// strings a Windows host would. The production code under test uses
// `path.win32.*` internally inside its `platform === "win32"` branch
// for the same reason — see the JSDoc on `resolveCopilotBin`.
const win = path.win32;

const FAKE_LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
const SHIM_DIR = win.join(FAKE_LOCALAPPDATA, "Microsoft", "WinGet", "Links");
const SHIM_PATH = win.join(SHIM_DIR, "copilot.exe");
const PACKAGES_DIR = win.join(FAKE_LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
const REAL_PACKAGE_DIR = "GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe";
const REAL_BIN = win.join(PACKAGES_DIR, REAL_PACKAGE_DIR, "copilot.exe");

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
  // The non-windows branch is tiny (early return) and platform-agnostic;
  // it runs on every OS.
  it("on non-windows is a pass-through", () => {
    const r = resolveCopilotBin("copilot", { platform: "linux" });
    expect(r).toEqual({ bin: "copilot", reason: "path-passthrough" });
  });

  // The win32 cases drive the WinGet-shim escape hatch. They use
  // win32-shaped paths and `platform: "win32"` mocks; production code
  // under test takes the same branch on a real Windows host. We still
  // gate on `process.platform === "win32"` to keep the test surface
  // honest: the only environment where these scenarios actually occur
  // *and* where the real `path` is `path.win32` is a Windows runner. On
  // POSIX runners the production code's `process.platform` would early-
  // return, so a "Linux runner with mocked win32" test is exercising
  // mocks against mocks rather than production. (Skipping here means
  // local POSIX dev keeps `pnpm test` green; CI pins Windows coverage
  // via the matrix.)
  describe.skipIf(process.platform !== "win32")("win32 branch", () => {
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
        exists: () => false, // no WinGet install
        readdir: () => [],
      });
      const r = resolveCopilotBin(customBin, deps);
      expect(r.bin).toBe(customBin);
      expect(r.reason).toBe("configured");
    });

    it("falls back to PATH hit when no WinGet install is found", () => {
      const r = resolveCopilotBin("copilot", {
        platform: "win32",
        env: { LOCALAPPDATA: FAKE_LOCALAPPDATA },
        which: () => SHIM_PATH,
        exists: () => false,
        readdir: () => [],
      });
      // Last resort: hand back the shim. Failure mode unchanged from
      // pre-resolver baseline; the user will hit the bug, but the
      // resolver hasn't introduced a new failure.
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
});

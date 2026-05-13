import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseWhereOutput,
  pickBestPathExtCandidate,
  type ResolveCopilotBinDeps,
  resolveCopilotBin,
} from "../../src/copilot/resolve-bin.js";

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

    // Regression for the npm-installed-Copilot ENOENT bug:
    // `where copilot` returns BOTH `copilot` (extensionless bash shim)
    // and `copilot.cmd` (Windows shim) on the same line. Pre-fix
    // `defaultWhich` took the first line — extensionless — and Node's
    // CreateProcess (which doesn't iterate PATHEXT) failed with
    // ENOENT. Fix: pick by extension priority (.exe > .cmd > .bat).
    // Resolver must hand back the .cmd path, not the bare name, so
    // spawn finds the file. The .cmd → cmd.exe wrap then lives in
    // launch-headless.ts (CVE-2024-27980 mitigation).

    it("returns the full PATH-resolved path (not the bare bin name) for npm-style installs", () => {
      // Simulate npm install: no WinGet at all, but `where copilot`
      // returns a .cmd shim somewhere on PATH.
      const npmShim = "C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd";
      const r = resolveCopilotBin("copilot", {
        platform: "win32",
        env: { LOCALAPPDATA: FAKE_LOCALAPPDATA }, // exists but no Packages/
        which: () => npmShim,
        exists: () => false,
        readdir: () => [],
      });
      // Pre-fix: returned the bare "copilot" → spawn ENOENT.
      // Post-fix: returns the full path → spawn finds the .cmd → wrap path takes over.
      expect(r.bin).toBe(npmShim);
      expect(r.reason).toBe("path-passthrough");
    });
  });
});

describe("parseWhereOutput", () => {
  it("splits on CRLF and LF, trims each line", () => {
    const out = parseWhereOutput("C:\\nodejs\\copilot\r\nC:\\nodejs\\copilot.cmd\r\n");
    expect(out).toEqual(["C:\\nodejs\\copilot", "C:\\nodejs\\copilot.cmd"]);
  });

  it("filters out empty lines (trailing newline doesn't produce a phantom entry)", () => {
    expect(parseWhereOutput("a\n\nb\n\n  \n")).toEqual(["a", "b"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseWhereOutput("")).toEqual([]);
    expect(parseWhereOutput("   \n  \r\n  ")).toEqual([]);
  });
});

describe("pickBestPathExtCandidate", () => {
  it("returns null when no candidates", () => {
    expect(pickBestPathExtCandidate([])).toBe(null);
  });

  it("prefers .exe over .cmd over .bat over .com", () => {
    expect(
      pickBestPathExtCandidate([
        "C:\\foo\\copilot.bat",
        "C:\\foo\\copilot.cmd",
        "C:\\foo\\copilot.exe",
      ]),
    ).toBe("C:\\foo\\copilot.exe");
    expect(pickBestPathExtCandidate(["C:\\foo\\copilot.bat", "C:\\foo\\copilot.cmd"])).toBe(
      "C:\\foo\\copilot.cmd",
    );
  });

  it("picks .cmd when an extensionless candidate sorts first (npm-shim regression)", () => {
    // npm install ships both — extensionless first per `where`'s
    // PATHEXT-iteration order, .cmd second. The pre-fix code took the
    // first line (extensionless) and spawn ENOENT'd because
    // CreateProcess doesn't try PATHEXT for a bare filename.
    expect(
      pickBestPathExtCandidate([
        "C:\\Users\\me\\AppData\\Roaming\\npm\\copilot",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd",
      ]),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd");
  });

  it("falls back to first candidate when nothing matches PATHEXT priority", () => {
    // Defense-in-depth: even if `where` somehow returns only
    // exotic-extension candidates (or extensionless-only), don't
    // return null — match pre-fix behaviour. May still spawn-fail,
    // but resolver hasn't introduced a new failure.
    expect(pickBestPathExtCandidate(["C:\\foo\\copilot"])).toBe("C:\\foo\\copilot");
    expect(pickBestPathExtCandidate(["C:\\foo\\copilot.ps1"])).toBe("C:\\foo\\copilot.ps1");
  });

  it("is case-insensitive on extension matching (Windows convention)", () => {
    expect(pickBestPathExtCandidate(["C:\\foo\\copilot.CMD", "C:\\foo\\copilot.EXE"])).toBe(
      "C:\\foo\\copilot.EXE",
    );
  });
});

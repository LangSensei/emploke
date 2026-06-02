import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  lstatSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { existsSync, lstatSync } from "node:fs";
import { existsLike, whichSyncDefault } from "../src/_shared.js";

const mockedLstat = vi.mocked(lstatSync);
const mockedExists = vi.mocked(existsSync);

describe("existsLike — robust presence check for Windows App Execution Aliases", () => {
  beforeEach(() => {
    mockedLstat.mockReset();
    mockedExists.mockReset();
  });

  it("returns true when lstatSync returns a stat (regular file or AppExec alias)", () => {
    // AppExec aliases (0-byte reparse points with tag
    // IO_REPARSE_TAG_APPEXECLINK) make existsSync return false because
    // it follows the link. lstatSync returns the reparse point's own
    // stat without following — which is the whole reason we use it.
    mockedLstat.mockReturnValue({ size: 0 } as never);
    const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    expect(existsLike(wt)).toBe(true);
    // existsSync must NOT be consulted on the happy path — that's
    // exactly the bug we're guarding against.
    expect(mockedExists).not.toHaveBeenCalled();
  });

  it("returns false when lstatSync returns undefined (throwIfNoEntry: false miss)", () => {
    mockedLstat.mockReturnValue(undefined as never);
    expect(existsLike("/missing/path")).toBe(false);
    expect(mockedExists).not.toHaveBeenCalled();
  });

  it("falls back to existsSync when lstatSync throws (e.g. EACCES on a restricted dir)", () => {
    mockedLstat.mockImplementation(() => {
      throw new Error("EACCES");
    });
    mockedExists.mockReturnValue(true);
    expect(existsLike("/forbidden")).toBe(true);
    expect(mockedExists).toHaveBeenCalledWith("/forbidden");
  });

  it("returns false when lstatSync throws AND existsSync also returns false", () => {
    mockedLstat.mockImplementation(() => {
      throw new Error("EACCES");
    });
    mockedExists.mockReturnValue(false);
    expect(existsLike("/forbidden")).toBe(false);
  });
});

describe("whichSyncDefault — best-effort PATH lookup", () => {
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockedExists.mockReset();
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathExt;
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }

  it("returns null when PATH is unset (no dirs to walk)", () => {
    setPlatform("linux");
    delete process.env.PATH;
    expect(whichSyncDefault("anything")).toBeNull();
    expect(mockedExists).not.toHaveBeenCalled();
  });

  it("returns the first matching path on linux (`:`-separated PATH, no extension)", () => {
    setPlatform("linux");
    process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
    const target = path.join("/usr/bin", "copilot");
    mockedExists.mockImplementation((p) => p === target);
    expect(whichSyncDefault("copilot")).toBe(target);
  });

  it("skips empty PATH segments produced by consecutive separators", () => {
    // If the empty segment were NOT skipped, the code would test
    // `path.join("", "copilot")` === "copilot" against existsSync,
    // which on a host where `./copilot` exists would wrongly resolve
    // to a bare-name match in cwd.
    setPlatform("linux");
    process.env.PATH = "/usr/local/bin::/usr/bin";
    const seen: string[] = [];
    mockedExists.mockImplementation((p) => {
      seen.push(String(p));
      return false;
    });
    expect(whichSyncDefault("copilot")).toBeNull();
    expect(seen).toEqual([
      path.join("/usr/local/bin", "copilot"),
      path.join("/usr/bin", "copilot"),
    ]);
  });

  it("walks PATHEXT-derived suffixes per PATH dir on win32, using `;` separators", () => {
    setPlatform("win32");
    process.env.PATH = "C:\\Windows;C:\\Tools";
    process.env.PATHEXT = ".EXE;.CMD;.BAT";
    const match = path.join("C:\\Tools", "copilot.cmd");
    const seen: string[] = [];
    mockedExists.mockImplementation((p) => {
      seen.push(String(p));
      return String(p) === match;
    });
    expect(whichSyncDefault("copilot")).toBe(match);
    // Order matters: each PATH dir is exhausted across all PATHEXT
    // suffixes before moving on, and the suffix is lowercased.
    expect(seen).toEqual([
      path.join("C:\\Windows", "copilot.exe"),
      path.join("C:\\Windows", "copilot.cmd"),
      path.join("C:\\Windows", "copilot.bat"),
      path.join("C:\\Tools", "copilot.exe"),
      path.join("C:\\Tools", "copilot.cmd"),
    ]);
  });

  it("defaults PATHEXT to `.EXE;.CMD;.BAT` on win32 when the env var is unset", () => {
    setPlatform("win32");
    process.env.PATH = "C:\\Tools";
    delete process.env.PATHEXT;
    const match = path.join("C:\\Tools", "copilot.bat");
    mockedExists.mockImplementation((p) => String(p) === match);
    expect(whichSyncDefault("copilot")).toBe(match);
  });

  it("returns null when nothing in PATH matches on linux", () => {
    setPlatform("linux");
    process.env.PATH = "/usr/bin:/bin";
    mockedExists.mockReturnValue(false);
    expect(whichSyncDefault("nonexistent")).toBeNull();
  });
});

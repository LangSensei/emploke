import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCwd, safeJoinUnderRoot } from "../src/paths.js";

const isWin = process.platform === "win32";

describe("normalizeCwd", () => {
  it("returns absolute path", () => {
    const out = normalizeCwd(".");
    expect(path.isAbsolute(out)).toBe(true);
  });

  it("strips trailing separators", () => {
    const base = path.resolve("/foo/bar");
    const trailing = base + path.sep;
    expect(normalizeCwd(trailing)).toBe(normalizeCwd(base));
  });

  it("does not strip the root separator", () => {
    if (isWin) {
      // C:\
      const root = path.parse(process.cwd()).root;
      const out = normalizeCwd(root);
      // Should still have at least the drive letter; not the empty string.
      expect(out.length).toBeGreaterThan(0);
    } else {
      expect(normalizeCwd("/")).toBe("/");
    }
  });

  it.runIf(isWin)("preserves the Windows drive root", () => {
    const root = path.parse(process.cwd()).root;
    const out = normalizeCwd(root);
    // Should preserve the trailing separator on the root (e.g. "c:\\").
    expect(out.endsWith(path.sep)).toBe(true);
  });

  it.runIf(isWin)("lower-cases on Windows for case-insensitive compare", () => {
    const a = normalizeCwd("C:\\Foo\\Bar");
    const b = normalizeCwd("c:\\foo\\bar");
    expect(a).toBe(b);
  });

  it.runIf(!isWin)("preserves case on non-Windows", () => {
    const a = normalizeCwd("/Foo/Bar");
    const b = normalizeCwd("/foo/bar");
    expect(a).not.toBe(b);
  });
});

describe("safeJoinUnderRoot", () => {
  const root = path.resolve("/some/root");

  it("returns child path for valid id", () => {
    const out = safeJoinUnderRoot(root, "20260508-010500-9dfbdf05");
    expect(out).toBe(path.join(root, "20260508-010500-9dfbdf05"));
  });

  it("rejects ids that escape via ..", () => {
    expect(() => safeJoinUnderRoot(root, "..")).toThrow(/escapes root|equals root/);
    expect(() => safeJoinUnderRoot(root, path.join("..", "sibling"))).toThrow(/escapes root/);
  });

  it.runIf(!isWin)("rejects absolute path id on POSIX", () => {
    expect(() => safeJoinUnderRoot(root, "/etc/passwd")).toThrow(/escapes root/);
  });

  it("rejects empty id (would equal root)", () => {
    expect(() => safeJoinUnderRoot(root, "")).toThrow(/equals root/);
  });

  it("treats /a/b vs /a/bb correctly (separator-suffixed root check)", () => {
    const r = path.resolve("/a/b");
    // Candidate resolves to a sibling /a/bb that shares a string prefix with
    // the root but is not under it. Use path.join so the separator is correct
    // on every platform.
    expect(() => safeJoinUnderRoot(r, path.join("..", "bb"))).toThrow(/escapes root/);
  });
});

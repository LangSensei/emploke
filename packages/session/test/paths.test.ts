import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeJoinUnderRoot } from "../src/paths.js";

const isWin = process.platform === "win32";

describe("safeJoinUnderRoot", () => {
  const root = path.resolve("/some/root");

  it("returns child path for valid id", () => {
    const out = safeJoinUnderRoot(root, "20260508-9dfbdf05");
    expect(out).toBe(path.join(root, "20260508-9dfbdf05"));
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
    expect(() => safeJoinUnderRoot(r, path.join("..", "bb"))).toThrow(/escapes root/);
  });
});

import { OriginParseError } from "@emploke/catalog-fetcher";
import { describe, expect, it } from "vitest";
import { Origin } from "../../../src/domain/value-objects/origin.js";

describe("Origin", () => {
  describe("parse", () => {
    it("accepts file: origins and exposes the parsed scheme", () => {
      const o = Origin.parse("file:/abs/path/to/skill");
      expect(o.value).toBe("file:/abs/path/to/skill");
      expect(o.scheme).toBe("file");
    });

    it("accepts well-formed github: origins", () => {
      const o = Origin.parse("https://github.com/owner/repo/tree/main/skills/x");
      expect(o.scheme).toBe("github");
      // Raw input round-trips byte-for-byte (no normalisation in PR-1).
      expect(o.value).toBe("https://github.com/owner/repo/tree/main/skills/x");
    });

    it("rejects empty / non-string input via TypeError", () => {
      expect(() => Origin.parse("")).toThrow(TypeError);
      // @ts-expect-error covers a runtime caller that bypasses TS
      expect(() => Origin.parse(undefined)).toThrow(TypeError);
    });

    it("rejects unsupported schemes via OriginParseError", () => {
      expect(() => Origin.parse("ftp://example.com/x")).toThrow(OriginParseError);
    });
  });

  describe("equality", () => {
    it("compares raw value byte-for-byte", () => {
      const a = Origin.parse("file:/abs/x");
      const b = Origin.parse("file:/abs/x");
      expect(a.equals(b)).toBe(true);
    });

    it("treats different raw forms as unequal even when they would normalise the same", () => {
      // PR-1 design choice: no normalisation; this asserts that contract.
      const a = Origin.parse("file:/abs/x");
      const b = Origin.parse("file:///abs/x");
      expect(a.equals(b)).toBe(false);
    });
  });
});

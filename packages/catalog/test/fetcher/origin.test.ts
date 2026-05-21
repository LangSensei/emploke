import { describe, expect, it } from "vitest";
import {
  FetchError,
  FetcherError,
  normalizeOrigin,
  OriginParseError,
  parseOrigin,
} from "../../src/fetcher/index.js";

describe("parseOrigin", () => {
  it("parses file: URI with absolute path", () => {
    const o = parseOrigin("file:/abs/path/to/skill");
    expect(o.scheme).toBe("file");
    if (o.scheme !== "file") throw new Error("narrow");
    expect(o.path).toBe("/abs/path/to/skill");
  });

  it("accepts file:/// triple-slash form (RFC 8089)", () => {
    const o = parseOrigin("file:///abs/path");
    expect(o.scheme).toBe("file");
    if (o.scheme !== "file") throw new Error("narrow");
    expect(o.path).toBe("/abs/path");
  });

  it("accepts Windows drive paths", () => {
    const o = parseOrigin("file:C:/Users/lang/skill");
    expect(o.scheme).toBe("file");
    if (o.scheme !== "file") throw new Error("narrow");
    expect(o.path).toBe("C:/Users/lang/skill");
  });

  it("accepts file:///C:/... Windows triple-slash form", () => {
    const o = parseOrigin("file:///C:/Users/lang/skill");
    expect(o.scheme).toBe("file");
    if (o.scheme !== "file") throw new Error("narrow");
    expect(o.path).toBe("C:/Users/lang/skill");
  });

  it("rejects file: URI with relative path", () => {
    expect(() => parseOrigin("file:./relative")).toThrow(OriginParseError);
    expect(() => parseOrigin("file:relative")).toThrow(OriginParseError);
    expect(() => parseOrigin("file:../sibling")).toThrow(OriginParseError);
  });

  it("rejects file: URI with home expansion (~)", () => {
    expect(() => parseOrigin("file:~/skills")).toThrow(OriginParseError);
  });

  it("parses github tree URL with subpath", () => {
    const o = parseOrigin("https://github.com/anthropic/skills/tree/main/tool-use");
    expect(o.scheme).toBe("github");
    if (o.scheme !== "github") throw new Error("narrow");
    expect(o.owner).toBe("anthropic");
    expect(o.repo).toBe("skills");
    expect(o.ref).toBe("main");
    expect(o.path).toBe("tool-use");
  });

  it("parses github tree URL with no subpath", () => {
    const o = parseOrigin("https://github.com/me/repo/tree/main");
    expect(o.scheme).toBe("github");
    if (o.scheme !== "github") throw new Error("narrow");
    expect(o.path).toBeNull();
  });

  it("rejects empty input with OriginParseError", () => {
    expect(() => parseOrigin("")).toThrow(OriginParseError);
  });

  it("rejects unknown scheme", () => {
    expect(() => parseOrigin("npm:something")).toThrow(OriginParseError);
  });

  it("rejects github URL without /tree/<ref>", () => {
    expect(() => parseOrigin("https://github.com/me/repo")).toThrow(OriginParseError);
  });
});

describe("normalizeOrigin", () => {
  it("returns canonical github form", () => {
    const a = normalizeOrigin(parseOrigin("https://github.com/MyOrg/Repo/tree/main/path"));
    expect(a).toBe("https://github.com/myorg/repo/tree/main/path");
  });

  it("treats github URL with and without trailing slash as same", () => {
    const a = normalizeOrigin(parseOrigin("https://github.com/me/repo/tree/main/path/"));
    const b = normalizeOrigin(parseOrigin("https://github.com/me/repo/tree/main/path"));
    expect(a).toBe(b);
  });
});

describe("error hierarchy", () => {
  it("OriginParseError extends FetcherError", () => {
    const e = new OriginParseError("bad", "reason");
    expect(e).toBeInstanceOf(FetcherError);
  });

  it("FetchError extends FetcherError", () => {
    const e = new FetchError("uri", "boom");
    expect(e).toBeInstanceOf(FetcherError);
  });
});

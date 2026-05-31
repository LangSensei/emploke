import { describe, expect, it } from "vitest";
import { splitFqn, splitFqnForDisplay } from "../../src/utils/fqn";

/**
 * Both helpers ultimately defer their boundary semantics to
 * `@emploke/catalog`'s canonical `splitFqn` (indexOf, exactly one `/`,
 * kebab-case scope + shortName). The strict version returns null on
 * malformed input; the display version falls back to
 * `{ scope: "", shortName: fqn }` so render paths never crash.
 */
describe("splitFqn (strict)", () => {
  it("splits a canonical scope/shortName fqn", () => {
    expect(splitFqn("public/researcher")).toEqual({
      scope: "public",
      shortName: "researcher",
    });
  });

  it("returns null when the input has no slash", () => {
    expect(splitFqn("solo")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(splitFqn("")).toBeNull();
  });

  it("returns null for a leading slash (empty scope)", () => {
    expect(splitFqn("/short")).toBeNull();
  });

  it("returns null for a trailing slash (empty shortName)", () => {
    expect(splitFqn("scope/")).toBeNull();
  });

  it("returns null for multi-slash inputs (canonical accepts exactly one)", () => {
    expect(splitFqn("a/b/c")).toBeNull();
  });
});

describe("splitFqnForDisplay (fallback)", () => {
  it("splits a canonical fqn on the first slash", () => {
    expect(splitFqnForDisplay("public/researcher")).toEqual({
      scope: "public",
      shortName: "researcher",
    });
  });

  it("renders the whole string in shortName when there is no slash", () => {
    expect(splitFqnForDisplay("malformed")).toEqual({
      scope: "",
      shortName: "malformed",
    });
  });

  it("renders an empty string as { scope: '', shortName: '' }", () => {
    expect(splitFqnForDisplay("")).toEqual({ scope: "", shortName: "" });
  });

  it("treats leading slash as empty scope + the rest as shortName", () => {
    expect(splitFqnForDisplay("/short")).toEqual({ scope: "", shortName: "short" });
  });

  it("treats trailing slash as empty shortName (no trailing-slash gluing)", () => {
    expect(splitFqnForDisplay("scope/")).toEqual({ scope: "scope", shortName: "" });
  });

  it("keeps everything after the first slash in shortName (no last-index semantics)", () => {
    expect(splitFqnForDisplay("a/b/c")).toEqual({ scope: "a", shortName: "b/c" });
  });
});

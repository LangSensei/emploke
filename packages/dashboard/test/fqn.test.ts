/**
 * Grammar pin for the dashboard's inlined `splitFqn` / `splitFqnForDisplay`
 * helpers (`packages/dashboard/src/utils/fqn.ts`).
 *
 * The strict `splitFqn` MUST mirror `packages/catalog/src/skill/validate.ts`
 * (lowercase kebab-case shortName + scope, scope additionally allows
 * reverse-DNS dots, each segment ≤ 64 chars, FQN has exactly one `/`).
 * The display helper is intentionally permissive — it never returns null
 * and splits on the FIRST `/` so render paths can't crash.
 *
 * If you change one of these helpers, change the other regex constant
 * in `utils/fqn.ts` in lockstep, then update this file. This is the
 * conscious duplication trade documented in that file's header comment.
 */

import { describe, expect, it } from "vitest";
import { splitFqn, splitFqnForDisplay } from "../src/utils/fqn";

describe("splitFqn (strict)", () => {
  // --- valid -----------------------------------------------------------
  it("splits a canonical kebab scope/shortName fqn", () => {
    expect(splitFqn("public/tool-use")).toEqual({
      scope: "public",
      shortName: "tool-use",
    });
  });

  it("splits a multi-hyphen short name", () => {
    expect(splitFqn("emploke/agent-distill")).toEqual({
      scope: "emploke",
      shortName: "agent-distill",
    });
  });

  it("accepts reverse-DNS dots in scope", () => {
    expect(splitFqn("com.example.foo/web-search")).toEqual({
      scope: "com.example.foo",
      shortName: "web-search",
    });
  });

  it("accepts numerics in segments", () => {
    expect(splitFqn("ns2/agent-v3")).toEqual({ scope: "ns2", shortName: "agent-v3" });
  });

  it("accepts 64-char scope and shortName at the boundary", () => {
    const seg = "a".repeat(64);
    expect(splitFqn(`${seg}/${seg}`)).toEqual({ scope: seg, shortName: seg });
  });

  // --- invalid: structural ---------------------------------------------
  it("returns null for an empty string", () => {
    expect(splitFqn("")).toBeNull();
  });

  it("returns null when the input has no '/'", () => {
    expect(splitFqn("public")).toBeNull();
  });

  it("returns null when the input has more than one '/'", () => {
    expect(splitFqn("public/foo/bar")).toBeNull();
  });

  it("returns null for a leading slash (empty scope)", () => {
    expect(splitFqn("/foo")).toBeNull();
  });

  it("returns null for a trailing slash (empty shortName)", () => {
    expect(splitFqn("foo/")).toBeNull();
  });

  // --- invalid: grammar -------------------------------------------------
  it("returns null for an uppercase scope", () => {
    expect(splitFqn("PUBLIC/foo")).toBeNull();
  });

  it("returns null for an uppercase shortName", () => {
    expect(splitFqn("public/Foo")).toBeNull();
  });

  it("returns null when the shortName contains a dot (dots are scope-only)", () => {
    expect(splitFqn("public/foo.bar")).toBeNull();
  });

  it("returns null for a double hyphen (kebab grammar bans consecutive hyphens)", () => {
    expect(splitFqn("public/foo--bar")).toBeNull();
  });

  it("returns null for a leading hyphen in shortName", () => {
    expect(splitFqn("public/-foo")).toBeNull();
  });

  it("returns null for an underscore in shortName (underscore is not kebab)", () => {
    expect(splitFqn("public/foo_bar")).toBeNull();
  });

  // --- invalid: length --------------------------------------------------
  it("returns null when scope exceeds 64 chars", () => {
    expect(splitFqn(`${"a".repeat(65)}/foo`)).toBeNull();
  });

  it("returns null when shortName exceeds 64 chars", () => {
    expect(splitFqn(`public/${"a".repeat(65)}`)).toBeNull();
  });

  // --- defensive: non-string input -------------------------------------
  it("returns null for non-string input", () => {
    // Callers occasionally pass through `?: string | undefined` values
    // from route params; the helper must not throw on those.
    expect(splitFqn(undefined as unknown as string)).toBeNull();
    expect(splitFqn(null as unknown as string)).toBeNull();
    expect(splitFqn(42 as unknown as string)).toBeNull();
  });
});

describe("splitFqnForDisplay (permissive)", () => {
  it("splits a canonical fqn on the first slash", () => {
    expect(splitFqnForDisplay("public/tool-use")).toEqual({
      scope: "public",
      shortName: "tool-use",
    });
  });

  it("renders the whole string in shortName when there is no slash", () => {
    expect(splitFqnForDisplay("single-segment")).toEqual({
      scope: "",
      shortName: "single-segment",
    });
  });

  it("renders an empty string as { scope: '', shortName: '' }", () => {
    expect(splitFqnForDisplay("")).toEqual({ scope: "", shortName: "" });
  });

  it("treats a leading slash as empty scope + the rest as shortName", () => {
    expect(splitFqnForDisplay("/short")).toEqual({ scope: "", shortName: "short" });
  });

  it("treats a trailing slash as empty shortName (no trailing-slash gluing)", () => {
    expect(splitFqnForDisplay("scope/")).toEqual({ scope: "scope", shortName: "" });
  });

  it("keeps everything after the first slash in shortName (first-slash semantics)", () => {
    expect(splitFqnForDisplay("a/b/c")).toEqual({ scope: "a", shortName: "b/c" });
  });

  it("does not validate grammar (uppercase passes through)", () => {
    // The display helper is intentionally lenient — it must not return
    // null or throw, so render paths can always show SOMETHING.
    expect(splitFqnForDisplay("PUBLIC/Foo")).toEqual({ scope: "PUBLIC", shortName: "Foo" });
  });
});

import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_NAMES,
  type PlaceholderContext,
  substitutePlaceholders,
  substitutePlaceholdersDeep,
  UnknownPlaceholderError,
} from "../src/placeholders.js";

const CTX: PlaceholderContext = {
  workspaceDir: "C:\\Users\\me\\code\\acme",
  sharedDir: "/home/me/.emploke/shared",
};

/**
 * Build a literal `${name}` token. Defined as a helper so the test
 * source doesn't contain literal `${...}` substrings — biome's
 * `useTemplate` lint flags those as "you forgot a template literal",
 * but here `${...}` IS the syntax under test, not a template-literal
 * accident. The helper sidesteps the linter without needing per-line
 * lint suppressions on every assertion.
 */
const ph = (name: string): string => `\${${name}}`;

describe("substitutePlaceholders", () => {
  it("replaces a bare placeholder with the matching context value", () => {
    expect(substitutePlaceholders(ph("workspaceDir"), CTX, "test")).toBe("C:/Users/me/code/acme");
    expect(substitutePlaceholders(ph("sharedDir"), CTX, "test")).toBe("/home/me/.emploke/shared");
  });

  it("converts backslashes to forward slashes so the same string works on Windows + POSIX", () => {
    // The Windows source value above contains `\`; the substituted result
    // must come out with `/` so MCP authors don't have to escape `\\\\`
    // in their JSON specs and so the resulting path round-trips through
    // node:fs identically on either OS.
    expect(substitutePlaceholders(`${ph("workspaceDir")}/sub`, CTX, "test")).toBe(
      "C:/Users/me/code/acme/sub",
    );
  });

  it("substitutes placeholders embedded inside a longer string", () => {
    expect(
      substitutePlaceholders(
        `--storage-state ${ph("workspaceDir")}/.playwright/state.json`,
        CTX,
        "test",
      ),
    ).toBe("--storage-state C:/Users/me/code/acme/.playwright/state.json");
  });

  it("substitutes multiple placeholders in one string", () => {
    expect(substitutePlaceholders(`${ph("workspaceDir")}::${ph("sharedDir")}`, CTX, "test")).toBe(
      "C:/Users/me/code/acme::/home/me/.emploke/shared",
    );
  });

  it("leaves a string with no placeholders untouched", () => {
    expect(substitutePlaceholders("npx", CTX, "test")).toBe("npx");
    expect(substitutePlaceholders("", CTX, "test")).toBe("");
  });

  it("throws UnknownPlaceholderError on an unrecognised name", () => {
    expect(() => substitutePlaceholders(ph("notAThing"), CTX, "mcps:demo")).toThrow(
      UnknownPlaceholderError,
    );
    try {
      substitutePlaceholders(ph("notAThing"), CTX, "mcps:demo");
    } catch (e) {
      const err = e as UnknownPlaceholderError;
      expect(err.placeholder).toBe("notAThing");
      expect(err.source).toBe("mcps:demo");
      expect(err.message).toContain("mcps:demo");
      // Error message lists the supported names so the user can fix the typo
      // without consulting docs.
      for (const n of PLACEHOLDER_NAMES) {
        expect(err.message).toContain(ph(n));
      }
    }
  });

  it(`rejects ${ph("globalDir")} distinctly from the generic unknown-name path`, () => {
    // `globalDir` is a near-miss for `sharedDir` (same concept, different
    // name) and a plausible accidental import from older shell-style
    // conventions. We pin it as an explicit reject so that a future
    // "be friendly, accept both names" PR has to actively delete this
    // test rather than just adding `globalDir` to PLACEHOLDER_NAMES —
    // the latter would silently pass the generic unknown-name test.
    expect(() => substitutePlaceholders(ph("globalDir"), CTX, "mcps:legacy")).toThrow(
      UnknownPlaceholderError,
    );
    expect(PLACEHOLDER_NAMES).not.toContain("globalDir");
    expect(PLACEHOLDER_NAMES).toContain("sharedDir");
  });

  it("does NOT do shell-style fallback or default syntax (kept simple on purpose)", () => {
    // `${workspaceDir:-/fallback}` is shell syntax; we don't honour it
    // because the marketplace audience writes JSON specs, not shell
    // scripts, and conditional placeholders introduce semantic ambiguity
    // we'd rather not litigate per spec.
    expect(() => substitutePlaceholders(ph("workspaceDir:-/fb"), CTX, "test")).toThrow(
      UnknownPlaceholderError,
    );
  });

  it("ignores `$workspaceDir` (no braces) and `$$` escapes - placeholders require braces", () => {
    // Mirroring VS Code: only the fully-qualified `${name}` form is a
    // placeholder. Single-`$` strings pass through verbatim.
    expect(substitutePlaceholders("$workspaceDir", CTX, "test")).toBe("$workspaceDir");
    expect(substitutePlaceholders(`$${ph("workspaceDir")}`, CTX, "test")).toBe(
      "$C:/Users/me/code/acme",
    );
  });
});

describe("substitutePlaceholdersDeep", () => {
  it("substitutes string leaves inside arrays + objects + nested mixes", () => {
    const input = {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--storage-state", `${ph("workspaceDir")}/state.json`],
      env: { GLOBAL_CACHE: `${ph("sharedDir")}/cache` },
      keepAsIs: 42,
      flag: true,
      nullable: null,
    };
    const out = substitutePlaceholdersDeep(input, CTX, "mcps:test");
    expect(out).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--storage-state", "C:/Users/me/code/acme/state.json"],
      env: { GLOBAL_CACHE: "/home/me/.emploke/shared/cache" },
      keepAsIs: 42,
      flag: true,
      nullable: null,
    });
  });

  it("propagates an UnknownPlaceholderError from a deeply-nested string", () => {
    const input = { args: [{ nested: [ph("typo")] }] };
    expect(() => substitutePlaceholdersDeep(input, CTX, "mcps:test")).toThrow(
      UnknownPlaceholderError,
    );
  });

  it("returns a new object/array - does not mutate the input", () => {
    const original = ph("workspaceDir");
    const input = { args: [original] };
    const out = substitutePlaceholdersDeep(input, CTX, "test") as typeof input;
    expect(input.args[0]).toBe(original);
    expect(out.args[0]).toBe("C:/Users/me/code/acme");
    expect(out).not.toBe(input);
    expect(out.args).not.toBe(input.args);
  });
});

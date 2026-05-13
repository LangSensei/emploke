import { describe, expect, it } from "vitest";
import {
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "../src/validate/install-input.js";

describe("validateSkillInstallInput", () => {
  it("accepts a plain { origin: <github-url> }", () => {
    const out = validateSkillInstallInput({
      origin: "https://github.com/o/r/tree/main/skills/x",
    });
    expect(out.origin).toBe("https://github.com/o/r/tree/main/skills/x");
  });

  it("accepts { origin: file:/abs/path }", () => {
    const out = validateSkillInstallInput({ origin: "file:/abs/x" });
    expect(out.origin).toBe("file:/abs/x");
  });

  it("trims surrounding whitespace from origin", () => {
    const out = validateSkillInstallInput({
      origin: "  https://github.com/o/r/tree/main/skills/x  ",
    });
    expect(out.origin).toBe("https://github.com/o/r/tree/main/skills/x");
  });

  it("rejects body that isn't an object", () => {
    expect(() => validateSkillInstallInput("string")).toThrow(/must be a JSON object/);
    expect(() => validateSkillInstallInput(["array"])).toThrow(/must be a JSON object/);
    expect(() => validateSkillInstallInput(null)).toThrow(/must be a JSON object/);
  });

  it("rejects missing origin field", () => {
    expect(() => validateSkillInstallInput({})).toThrow(/origin/);
  });

  it("rejects empty-string origin", () => {
    expect(() => validateSkillInstallInput({ origin: "" })).toThrow(/origin/);
  });

  it("rejects non-string origin", () => {
    expect(() => validateSkillInstallInput({ origin: 42 })).toThrow(/origin/);
    expect(() => validateSkillInstallInput({ origin: null })).toThrow(/origin/);
    expect(() => validateSkillInstallInput({ origin: { url: "x" } })).toThrow(/origin/);
  });

  // Format validation (must start with `https://github.com/` or
  // `file:`) is intentionally NOT done here — the catalog-fetcher's
  // parseOrigin is the single source of truth for scheme rules and
  // throws OriginParseError at fetch time. The validator only enforces
  // the wire-level shape (field exists + non-empty string). Keeping
  // them separate means new providers (e.g. `npm:`, `oci:`) need
  // exactly one site change (the fetcher registry), not two.
  it("does NOT enforce origin format (delegated to parseOrigin at fetch time)", () => {
    // ftp:// is not a recognised scheme, but the validator accepts
    // it — the fetcher will reject it later. Same for any other
    // free-form string the validator hasn't been told about.
    expect(validateSkillInstallInput({ origin: "ftp://example.com/x" })).toEqual({
      origin: "ftp://example.com/x",
    });
    expect(validateSkillInstallInput({ origin: "anything-goes-here" })).toEqual({
      origin: "anything-goes-here",
    });
  });

  it("ignores legacy { provider, location } fields when an origin is also present", () => {
    // Defensive: if a stale client (e.g. an old dashboard tab the
    // user left open) sends BOTH the legacy pair and the new origin,
    // we honour the origin. The pair is silently dropped — there's
    // no scenario where keeping it would help.
    const out = validateSkillInstallInput({
      provider: "github",
      location: "https://github.com/legacy/path",
      origin: "https://github.com/o/r/tree/main/skills/x",
    });
    expect(out.origin).toBe("https://github.com/o/r/tree/main/skills/x");
  });

  it("rejects a body that has only legacy { provider, location } without origin", () => {
    // Confirms the BREAKING wire-shape change: the previous
    // `{ provider, location }` form is no longer accepted. The
    // dashboard moved its assembly to client-side; CLI was always
    // sending `{ origin }`. Test pins the regression: any code path
    // that re-introduces the legacy form will fail loudly here.
    expect(() =>
      validateSkillInstallInput({
        provider: "github",
        location: "https://github.com/o/r/tree/main",
      }),
    ).toThrow(/origin/);
  });
});

describe("validateAgentInstallInput", () => {
  it("mirrors skill validator behaviour", () => {
    const out = validateAgentInstallInput({ origin: "file:/abs/agent" });
    expect(out.origin).toBe("file:/abs/agent");
  });

  it("rejects missing origin", () => {
    expect(() => validateAgentInstallInput({})).toThrow(/origin/);
  });
});

describe("validateMcpInstallInput", () => {
  it("requires only origin (no name — server derives from _meta.name)", () => {
    const out = validateMcpInstallInput({
      origin: "file:/abs/azure.json",
    });
    expect(out.origin).toBe("file:/abs/azure.json");
    // McpInstallBody no longer carries `name` — it's recovered from
    // the fetched JSON's _meta.name at install time.
    expect((out as Record<string, unknown>).name).toBeUndefined();
  });

  it("ignores any caller-supplied name (no longer part of contract)", () => {
    const out = validateMcpInstallInput({
      origin: "https://github.com/o/r/tree/main/mcps/x.json",
      name: "ignored/name",
    });
    expect(out.origin).toBe("https://github.com/o/r/tree/main/mcps/x.json");
  });

  it("rejects body without origin", () => {
    expect(() => validateMcpInstallInput({})).toThrow(/origin/);
  });
});

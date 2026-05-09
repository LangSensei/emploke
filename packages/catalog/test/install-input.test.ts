import { describe, expect, it } from "vitest";
import { FrontmatterError, McpNameInvalidError } from "../src/errors.js";
import {
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "../src/install-input.js";

describe("validateSkillInstallInput", () => {
  it("accepts { origin }", () => {
    const out = validateSkillInstallInput({ origin: "file:/x" });
    expect(out.origin).toBe("file:/x");
    expect(out.scopeHints).toBeUndefined();
  });

  it("accepts { origin, scopeHints }", () => {
    const out = validateSkillInstallInput({
      origin: "file:/x",
      scopeHints: { "ns/foo": "my-fork" },
    });
    expect(out.scopeHints).toEqual({ "ns/foo": "my-fork" });
  });

  it("rejects non-object body", () => {
    expect(() => validateSkillInstallInput("hi")).toThrow(FrontmatterError);
    expect(() => validateSkillInstallInput(null)).toThrow(FrontmatterError);
    expect(() => validateSkillInstallInput([])).toThrow(FrontmatterError);
  });

  it("rejects missing origin", () => {
    expect(() => validateSkillInstallInput({})).toThrow(/`origin` is required/);
  });

  it("rejects empty-string origin", () => {
    expect(() => validateSkillInstallInput({ origin: "" })).toThrow(/`origin`/);
  });

  it("rejects non-object scopeHints", () => {
    expect(() => validateSkillInstallInput({ origin: "file:/x", scopeHints: "no" })).toThrow(
      /scopeHints/,
    );
  });

  it("rejects scopeHints with non-string scope value", () => {
    expect(() =>
      validateSkillInstallInput({ origin: "file:/x", scopeHints: { foo: 123 } }),
    ).toThrow(/scopeHints/);
  });

  it("validates scopeHints scope grammar", () => {
    expect(() =>
      validateSkillInstallInput({ origin: "file:/x", scopeHints: { foo: "BAD_SCOPE" } }),
    ).toThrow();
  });
});

describe("validateAgentInstallInput", () => {
  it("accepts { origin }", () => {
    const out = validateAgentInstallInput({ origin: "file:/x" });
    expect(out.origin).toBe("file:/x");
  });
});

describe("validateMcpInstallInput", () => {
  it("accepts { origin, name }", () => {
    const out = validateMcpInstallInput({ origin: "file:/x", name: "azure/mcp" });
    expect(out).toEqual({ origin: "file:/x", name: "azure/mcp" });
  });

  it("rejects missing name", () => {
    expect(() => validateMcpInstallInput({ origin: "file:/x" })).toThrow(/`name`/);
  });

  it("rejects MCP name without slash", () => {
    expect(() => validateMcpInstallInput({ origin: "file:/x", name: "noslash" })).toThrow(
      McpNameInvalidError,
    );
  });

  it("rejects MCP name with multiple slashes", () => {
    expect(() => validateMcpInstallInput({ origin: "file:/x", name: "a/b/c" })).toThrow(
      McpNameInvalidError,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  buildOriginFrom,
  validateAgentInstallInput,
  validateMcpInstallInput,
  validateSkillInstallInput,
} from "../src/validate/install-input.js";

describe("buildOriginFrom", () => {
  it("github: passes the URL through verbatim (already canonical)", () => {
    const url = "https://github.com/owner/repo/tree/main/skills/foo";
    expect(buildOriginFrom("github", url)).toBe(url);
  });

  it("file: prepends file: prefix", () => {
    expect(buildOriginFrom("file", "/abs/path")).toBe("file:/abs/path");
    expect(buildOriginFrom("file", "C:/Users/me/skill")).toBe("file:C:/Users/me/skill");
  });

  it("file: tolerates an already-prefixed paste (idempotent)", () => {
    expect(buildOriginFrom("file", "file:/abs/path")).toBe("file:/abs/path");
  });

  it("trims surrounding whitespace before assembling", () => {
    expect(buildOriginFrom("file", "  /abs/path  ")).toBe("file:/abs/path");
    expect(buildOriginFrom("github", "  https://github.com/o/r/tree/main  ")).toBe(
      "https://github.com/o/r/tree/main",
    );
  });
});

describe("validateSkillInstallInput", () => {
  it("accepts {provider:'github', location: <url>}", () => {
    const out = validateSkillInstallInput({
      provider: "github",
      location: "https://github.com/o/r/tree/main/skills/x",
    });
    expect(out.origin).toBe("https://github.com/o/r/tree/main/skills/x");
  });

  it("accepts {provider:'file', location: <abs path>}", () => {
    const out = validateSkillInstallInput({ provider: "file", location: "/abs/x" });
    expect(out.origin).toBe("file:/abs/x");
  });

  it("rejects body that isn't an object", () => {
    expect(() => validateSkillInstallInput("string")).toThrow(/must be a JSON object/);
    expect(() => validateSkillInstallInput(["array"])).toThrow(/must be a JSON object/);
    expect(() => validateSkillInstallInput(null)).toThrow(/must be a JSON object/);
  });

  it("rejects unknown provider", () => {
    expect(() =>
      validateSkillInstallInput({ provider: "ftp", location: "ftp://example.com/x" }),
    ).toThrow(/`provider` must be one of/);
  });

  it("rejects missing fields", () => {
    expect(() => validateSkillInstallInput({ provider: "github" })).toThrow(/location/);
    expect(() => validateSkillInstallInput({ location: "/abs/x" })).toThrow(/provider/);
    expect(() => validateSkillInstallInput({})).toThrow();
  });

  it("rejects empty-string fields", () => {
    expect(() => validateSkillInstallInput({ provider: "", location: "/x" })).toThrow();
    expect(() => validateSkillInstallInput({ provider: "github", location: "" })).toThrow();
  });
});

describe("validateAgentInstallInput", () => {
  it("mirrors skill validator behaviour", () => {
    const out = validateAgentInstallInput({ provider: "file", location: "/abs/agent" });
    expect(out.origin).toBe("file:/abs/agent");
  });
});

describe("validateMcpInstallInput", () => {
  it("requires only provider+location (no name — server derives from _meta.name)", () => {
    const out = validateMcpInstallInput({
      provider: "file",
      location: "/abs/azure.json",
    });
    expect(out.origin).toBe("file:/abs/azure.json");
    // McpInstallBody no longer carries `name` — it's recovered from
    // the fetched JSON's _meta.name at install time.
    expect((out as Record<string, unknown>).name).toBeUndefined();
  });

  it("ignores any caller-supplied name (no longer part of contract)", () => {
    const out = validateMcpInstallInput({
      provider: "github",
      location: "https://github.com/o/r/tree/main/mcps/x.json",
      name: "ignored/name",
    });
    expect(out.origin).toBe("https://github.com/o/r/tree/main/mcps/x.json");
  });

  it("rejects body without provider or location", () => {
    expect(() => validateMcpInstallInput({ provider: "file" })).toThrow(/location/);
    expect(() => validateMcpInstallInput({ location: "/abs/x.json" })).toThrow(/provider/);
  });
});

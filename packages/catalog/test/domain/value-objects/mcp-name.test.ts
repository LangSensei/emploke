import { describe, expect, it } from "vitest";
import { McpName } from "../../../src/domain/value-objects/mcp-name.js";
import { McpNameInvalidError } from "../../../src/mcp/errors.js";

describe("McpName", () => {
  describe("parse", () => {
    it("returns a VO whose canonical form round-trips the input", () => {
      const name = McpName.parse("azure/mcp");
      expect(name.namespace).toBe("azure");
      expect(name.shortName).toBe("mcp");
      expect(name.toCanonical()).toBe("azure/mcp");
    });

    it("accepts dotted namespaces (reverse-DNS-ish)", () => {
      const name = McpName.parse("dev.example/tool");
      expect(name.namespace).toBe("dev.example");
      expect(name.shortName).toBe("tool");
    });

    it("rejects whitespace and control characters", () => {
      expect(() => McpName.parse("ns/with space")).toThrow(McpNameInvalidError);
      expect(() => McpName.parse("ns/with\ttab")).toThrow(McpNameInvalidError);
    });

    it("rejects multiple slashes", () => {
      expect(() => McpName.parse("a/b/c")).toThrow(McpNameInvalidError);
    });

    it("rejects . / .. as path segments", () => {
      expect(() => McpName.parse("./mcp")).toThrow(McpNameInvalidError);
      expect(() => McpName.parse("ns/..")).toThrow(McpNameInvalidError);
    });
  });

  describe("equality", () => {
    it("treats VOs with the same components as equal", () => {
      const a = McpName.parse("azure/mcp");
      const b = McpName.create("azure", "mcp");
      expect(a.equals(b)).toBe(true);
    });

    it("treats VOs with different components as unequal", () => {
      const a = McpName.parse("azure/mcp");
      const b = McpName.parse("aws/mcp");
      expect(a.equals(b)).toBe(false);
    });

    it("does not match across VO concrete types", async () => {
      const mcp = McpName.parse("azure/mcp");
      const { SkillFqn } = await import("../../../src/domain/value-objects/skill-fqn.js");
      // Same canonical string but distinct VO classes => not equal.
      const skill = SkillFqn.parse("azure/mcp");
      expect(mcp.equals(skill)).toBe(false);
    });
  });
});

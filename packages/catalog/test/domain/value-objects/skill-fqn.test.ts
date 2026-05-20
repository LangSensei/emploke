import { describe, expect, it } from "vitest";
import { SkillFqn } from "../../../src/domain/value-objects/skill-fqn.js";
import { SkillNameInvalidError } from "../../../src/skill/errors.js";

describe("SkillFqn", () => {
  describe("parse", () => {
    it("returns a VO whose canonical form round-trips the input", () => {
      const fqn = SkillFqn.parse("public/tool-use");
      expect(fqn.scope).toBe("public");
      expect(fqn.shortName).toBe("tool-use");
      expect(fqn.toCanonical()).toBe("public/tool-use");
      expect(fqn.toString()).toBe("public/tool-use");
    });

    it("rejects strings without a slash", () => {
      expect(() => SkillFqn.parse("no-slash")).toThrow(SkillNameInvalidError);
    });

    it("rejects strings with an invalid scope segment", () => {
      expect(() => SkillFqn.parse("Bad-Scope/short")).toThrow(SkillNameInvalidError);
    });

    it("rejects strings with an invalid short-name segment", () => {
      expect(() => SkillFqn.parse("public/Bad_Short")).toThrow(SkillNameInvalidError);
    });
  });

  describe("create", () => {
    it("composes a VO from validated parts", () => {
      const fqn = SkillFqn.create("public", "tool-use");
      expect(fqn.toCanonical()).toBe("public/tool-use");
    });

    it("rejects bad parts at the construction-time gate", () => {
      expect(() => SkillFqn.create("BAD", "tool-use")).toThrow(SkillNameInvalidError);
      expect(() => SkillFqn.create("public", "TOOL_USE")).toThrow(SkillNameInvalidError);
    });
  });

  describe("equality", () => {
    it("treats VOs with the same components as equal", () => {
      const a = SkillFqn.parse("public/tool-use");
      const b = SkillFqn.create("public", "tool-use");
      expect(a.equals(b)).toBe(true);
      expect(b.equals(a)).toBe(true);
    });

    it("treats VOs with different components as unequal", () => {
      const a = SkillFqn.parse("public/tool-use");
      const b = SkillFqn.parse("public/web-search");
      expect(a.equals(b)).toBe(false);
    });

    it("does not match across VO concrete types", async () => {
      const skill = SkillFqn.parse("public/tool-use");
      // import lazily so the test file's primary subject is SkillFqn
      const { AgentFqn } = await import("../../../src/domain/value-objects/agent-fqn.js");
      const agent = AgentFqn.parse("public/tool-use");
      // Same canonical string, distinct VO classes => not equal.
      expect(skill.equals(agent)).toBe(false);
    });
  });
});

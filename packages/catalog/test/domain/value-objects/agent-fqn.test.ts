import { describe, expect, it } from "vitest";
import { AgentNameInvalidError } from "../../../src/agent/errors.js";
import { AgentFqn } from "../../../src/domain/value-objects/agent-fqn.js";

describe("AgentFqn", () => {
  describe("parse", () => {
    it("returns a VO whose canonical form round-trips the input", () => {
      const fqn = AgentFqn.parse("public/researcher");
      expect(fqn.scope).toBe("public");
      expect(fqn.shortName).toBe("researcher");
      expect(fqn.toCanonical()).toBe("public/researcher");
    });

    it("raises AgentNameInvalidError on bad input", () => {
      expect(() => AgentFqn.parse("no-slash")).toThrow(AgentNameInvalidError);
      expect(() => AgentFqn.parse("BAD/researcher")).toThrow(AgentNameInvalidError);
      expect(() => AgentFqn.parse("public/BAD")).toThrow(AgentNameInvalidError);
    });
  });

  describe("create", () => {
    it("composes a VO from validated parts", () => {
      const fqn = AgentFqn.create("public", "researcher");
      expect(fqn.toCanonical()).toBe("public/researcher");
    });

    it("rejects bad parts at the construction-time gate", () => {
      expect(() => AgentFqn.create("BAD", "researcher")).toThrow(AgentNameInvalidError);
    });
  });

  describe("equality", () => {
    it("treats VOs with the same components as equal", () => {
      const a = AgentFqn.parse("public/researcher");
      const b = AgentFqn.create("public", "researcher");
      expect(a.equals(b)).toBe(true);
    });

    it("treats VOs with different components as unequal", () => {
      const a = AgentFqn.parse("public/researcher");
      const b = AgentFqn.parse("public/web-builder");
      expect(a.equals(b)).toBe(false);
    });
  });
});

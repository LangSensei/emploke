import { describe, expect, it } from "vitest";
import { WorkspaceNameInvalidError } from "../../../src/domain/exceptions/workspace-errors.js";
import { WorkspaceName } from "../../../src/testing.js";

describe("WorkspaceName value object", () => {
  it("accepts free-form unicode display names", () => {
    for (const ok of ["Emploke", "My Project", "工作区", " launch", "x", "a".repeat(64)]) {
      expect(WorkspaceName.of(ok).value).toBe(ok);
    }
  });

  it("rejects empty / whitespace-only", () => {
    for (const bad of ["", "   ", "\t"]) {
      expect(() => WorkspaceName.of(bad)).toThrow(WorkspaceNameInvalidError);
    }
  });

  it("rejects too-long names", () => {
    expect(() => WorkspaceName.of("a".repeat(65))).toThrow(WorkspaceNameInvalidError);
  });

  it("rejects control characters", () => {
    expect(() => WorkspaceName.of("foo\u0000bar")).toThrow(WorkspaceNameInvalidError);
    expect(() => WorkspaceName.of("line1\nline2")).toThrow(WorkspaceNameInvalidError);
  });

  it("structural equality compares by value", () => {
    expect(WorkspaceName.of("Project").equals(WorkspaceName.of("Project"))).toBe(true);
    expect(WorkspaceName.of("Project").equals(WorkspaceName.of("Other"))).toBe(false);
  });

  describe("static validators", () => {
    it("assertValid throws for non-strings", () => {
      for (const bad of [undefined, null, 123, {}, []]) {
        expect(() => WorkspaceName.assertValid(bad)).toThrow(WorkspaceNameInvalidError);
      }
    });

    it("isValid mirrors assertValid", () => {
      expect(WorkspaceName.isValid("OK")).toBe(true);
      expect(WorkspaceName.isValid("")).toBe(false);
      expect(WorkspaceName.isValid(undefined)).toBe(false);
      expect(WorkspaceName.isValid("nope\nbad")).toBe(false);
      expect(WorkspaceName.isValid("a".repeat(65))).toBe(false);
    });
  });
});

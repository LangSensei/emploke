import { describe, expect, it } from "vitest";
import { WorkspaceNameInvalidError } from "../src/errors.js";
import { assertValidDisplayName, isValidDisplayName, isValidWorkspaceId } from "../src/names.js";

describe("assertValidDisplayName", () => {
  it("accepts free-form names including unicode", () => {
    for (const ok of [
      "Emploke",
      "My Project",
      "工作区",
      " launch",
      "x",
      "with-hyphens-and_underscores.dots",
      "a".repeat(64),
    ]) {
      expect(() => assertValidDisplayName(ok)).not.toThrow();
    }
  });

  it("rejects non-string", () => {
    for (const bad of [undefined, null, 123, {}, []]) {
      expect(() => assertValidDisplayName(bad)).toThrow(WorkspaceNameInvalidError);
    }
  });

  it("rejects empty / whitespace-only", () => {
    for (const bad of ["", "   ", "\t", "\n  \t"]) {
      expect(() => assertValidDisplayName(bad)).toThrow(WorkspaceNameInvalidError);
    }
  });

  it("rejects names too long", () => {
    expect(() => assertValidDisplayName("a".repeat(65))).toThrow(WorkspaceNameInvalidError);
    expect(() => assertValidDisplayName("a".repeat(64))).not.toThrow();
  });

  it("rejects ASCII control characters", () => {
    for (const bad of ["foo\u0000bar", "line1\nline2", "tab\there", "del\u007F"]) {
      expect(() => assertValidDisplayName(bad)).toThrow(WorkspaceNameInvalidError);
    }
  });

  it("isValidDisplayName mirrors assert", () => {
    expect(isValidDisplayName("OK Name")).toBe(true);
    expect(isValidDisplayName("")).toBe(false);
    expect(isValidDisplayName(undefined)).toBe(false);
    expect(isValidDisplayName("nope\nbad")).toBe(false);
  });
});

describe("isValidWorkspaceId", () => {
  it("accepts canonical UUIDs of any version", () => {
    for (const ok of [
      "550e8400-e29b-41d4-a716-446655440000",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "12345678-1234-1234-1234-123456789abc",
      "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    ]) {
      expect(isValidWorkspaceId(ok)).toBe(true);
    }
  });

  it("rejects non-uuid strings", () => {
    for (const bad of [
      "",
      "not-a-uuid",
      "550e8400-e29b-41d4-a716-44665544000", // too short
      "550e8400-e29b-41d4-a716-4466554400000", // too long
      "550e8400e29b41d4a716446655440000", // missing dashes
      undefined,
      null,
      123,
    ]) {
      expect(isValidWorkspaceId(bad)).toBe(false);
    }
  });
});

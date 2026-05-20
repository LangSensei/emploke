import { describe, expect, it } from "vitest";
import { WorkspaceIdInvalidError } from "../../../src/domain/exceptions/workspace-errors.js";
import { WorkspaceId } from "../../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("WorkspaceId value object", () => {
  it("accepts canonical UUIDs", () => {
    expect(WorkspaceId.of(UUID_A).value).toBe(UUID_A);
  });

  it("rejects non-UUID strings", () => {
    expect(() => WorkspaceId.of("not-a-uuid")).toThrow(WorkspaceIdInvalidError);
    expect(() => WorkspaceId.of("")).toThrow(WorkspaceIdInvalidError);
  });

  it("structural equality compares by value", () => {
    expect(WorkspaceId.of(UUID_A).equals(WorkspaceId.of(UUID_A))).toBe(true);
    expect(WorkspaceId.of(UUID_A).equals(WorkspaceId.of(UUID_B))).toBe(false);
  });

  it("toString returns the underlying value", () => {
    expect(WorkspaceId.of(UUID_A).toString()).toBe(UUID_A);
  });

  describe("static validators", () => {
    it("isValid accepts canonical UUIDs of any version", () => {
      for (const ok of [
        "550e8400-e29b-41d4-a716-446655440000",
        "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      ]) {
        expect(WorkspaceId.isValid(ok)).toBe(true);
      }
    });

    it("isValid rejects non-uuid strings and non-strings", () => {
      for (const bad of [
        "",
        "not-a-uuid",
        "550e8400e29b41d4a716446655440000",
        undefined,
        null,
        123,
      ]) {
        expect(WorkspaceId.isValid(bad)).toBe(false);
      }
    });

    it("assertValid throws WorkspaceIdInvalidError on bad input", () => {
      expect(() => WorkspaceId.assertValid("nope")).toThrow(WorkspaceIdInvalidError);
      expect(() => WorkspaceId.assertValid(null)).toThrow(WorkspaceIdInvalidError);
    });
  });
});

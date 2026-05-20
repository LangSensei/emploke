import { describe, expect, it } from "vitest";
import { WorkspaceIdInvalidError } from "../../../src/domain/errors.js";
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
});

import { describe, expect, it } from "vitest";
import {
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
} from "../src/index.js";
import {
  assertValidWorkspaceId,
  assertValidWorkspaceName,
  isValidWorkspaceId,
  isValidWorkspaceName,
  normalizeWorkspaceDir,
} from "../src/validate.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("validators: workspace id", () => {
  it("isValidWorkspaceId accepts UUIDs (any version)", () => {
    expect(isValidWorkspaceId(UUID)).toBe(true);
    expect(isValidWorkspaceId("11111111-1111-1111-8111-111111111111")).toBe(true);
  });

  it("isValidWorkspaceId rejects non-UUIDs", () => {
    expect(isValidWorkspaceId("not-a-uuid")).toBe(false);
    expect(isValidWorkspaceId("")).toBe(false);
    expect(isValidWorkspaceId(123 as unknown as string)).toBe(false);
    expect(isValidWorkspaceId(null)).toBe(false);
  });

  it("assertValidWorkspaceId throws on invalid", () => {
    expect(() => assertValidWorkspaceId("not-a-uuid")).toThrow(WorkspaceIdInvalidError);
  });

  it("assertValidWorkspaceId passes for valid UUID", () => {
    expect(() => assertValidWorkspaceId(UUID)).not.toThrow();
  });
});

describe("validators: workspace name", () => {
  it("isValidWorkspaceName accepts non-empty, in-range, no-control-char strings", () => {
    expect(isValidWorkspaceName("Project")).toBe(true);
    expect(isValidWorkspaceName("中文 ")).toBe(true);
    expect(isValidWorkspaceName("🚀")).toBe(true);
  });

  it("rejects empty / whitespace-only", () => {
    expect(isValidWorkspaceName("")).toBe(false);
    expect(isValidWorkspaceName("   ")).toBe(false);
  });

  it("rejects names over 64 chars", () => {
    expect(isValidWorkspaceName("a".repeat(65))).toBe(false);
    expect(isValidWorkspaceName("a".repeat(64))).toBe(true);
  });

  it("rejects control characters", () => {
    expect(isValidWorkspaceName("hello\u0001world")).toBe(false);
    expect(isValidWorkspaceName("hello\u007Fworld")).toBe(false);
  });

  it("assertValidWorkspaceName throws WorkspaceNameInvalidError on bad input", () => {
    expect(() => assertValidWorkspaceName("")).toThrow(WorkspaceNameInvalidError);
    expect(() => assertValidWorkspaceName(42 as unknown as string)).toThrow(
      WorkspaceNameInvalidError,
    );
  });
});

describe("validators: workspace dir", () => {
  it("resolves relative paths to absolute", () => {
    const out = normalizeWorkspaceDir("relative/dir");
    expect(out).toMatch(/[\\/]relative[\\/]dir$/);
  });

  it("keeps absolute paths intact (modulo path.resolve)", () => {
    const out = normalizeWorkspaceDir("/tmp/x");
    expect(out).toMatch(/[\\/]tmp[\\/]x$/);
  });

  it("throws on empty / non-string input", () => {
    expect(() => normalizeWorkspaceDir("")).toThrow(TypeError);
    expect(() => normalizeWorkspaceDir("   ")).toThrow(TypeError);
    expect(() => normalizeWorkspaceDir(null as unknown as string)).toThrow(TypeError);
  });
});

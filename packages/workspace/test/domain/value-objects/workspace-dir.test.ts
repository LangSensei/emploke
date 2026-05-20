import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceDir } from "../../../src/testing.js";

describe("WorkspaceDir value object", () => {
  it("resolves relative paths to absolute", () => {
    const wd = WorkspaceDir.of("some/rel/path");
    expect(path.isAbsolute(wd.value)).toBe(true);
    expect(wd.value).toBe(path.resolve("some/rel/path"));
  });

  it("preserves absolute paths verbatim", () => {
    const abs = path.resolve("/tmp/x") as string;
    expect(WorkspaceDir.of(abs).value).toBe(abs);
  });

  it("rejects empty / non-string", () => {
    expect(() => WorkspaceDir.of("")).toThrow(TypeError);
    expect(() => WorkspaceDir.of("   ")).toThrow(TypeError);
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
    expect(() => WorkspaceDir.of(123 as any)).toThrow(TypeError);
  });

  it("structural equality compares by resolved path", () => {
    expect(WorkspaceDir.of("x/y").equals(WorkspaceDir.of("x/y"))).toBe(true);
  });
});

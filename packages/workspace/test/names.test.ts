import { describe, expect, it } from "vitest";
import { WorkspaceNameInvalidError } from "../src/errors.js";
import { assertValidWorkspaceName, isValidWorkspaceName } from "../src/names.js";

describe("assertValidWorkspaceName", () => {
  it("accepts simple kebab-case", () => {
    for (const ok of ["a", "abc", "my-workspace", "swat-dev", "foo123", "x9-y2-z3"]) {
      expect(() => assertValidWorkspaceName(ok)).not.toThrow();
    }
  });

  it("rejects non-string and empty", () => {
    for (const bad of [undefined, null, 123, {}, ""]) {
      expect(() => assertValidWorkspaceName(bad)).toThrow(WorkspaceNameInvalidError);
    }
  });

  it("rejects names too long", () => {
    expect(() => assertValidWorkspaceName("a".repeat(65))).toThrow(WorkspaceNameInvalidError);
    expect(() => assertValidWorkspaceName("a".repeat(64))).not.toThrow();
  });

  it("rejects upper case, leading digit, slashes, dots, underscores", () => {
    for (const bad of [
      "Foo",
      "fooBar",
      "9foo",
      "foo/bar",
      "foo.bar",
      "foo_bar",
      "foo bar",
      "-foo",
      "foo--bar",
      "foo-",
    ]) {
      expect(() => assertValidWorkspaceName(bad)).toThrow(WorkspaceNameInvalidError);
    }
  });

  it("isValidWorkspaceName mirrors assert", () => {
    expect(isValidWorkspaceName("ok-name")).toBe(true);
    expect(isValidWorkspaceName("Bad")).toBe(false);
    expect(isValidWorkspaceName(undefined)).toBe(false);
  });
});

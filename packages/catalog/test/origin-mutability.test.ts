import { describe, expect, it } from "vitest";
import { ImmutableOriginError, isOriginMutable } from "../src/origin-mutability.js";

describe("isOriginMutable", () => {
  it("treats absolute file: origins as mutable", () => {
    expect(isOriginMutable("file:/abs/path")).toBe(true);
    expect(isOriginMutable("file:///abs/path")).toBe(true);
    expect(isOriginMutable("file:C:/Users/me/skill")).toBe(true);
    expect(isOriginMutable("file:///C:/Users/me/skill")).toBe(true);
  });

  it("treats github: origins as immutable", () => {
    expect(isOriginMutable("https://github.com/owner/repo/tree/main/skills/x")).toBe(false);
  });

  it("treats unparseable / malformed origins as immutable (defensive default)", () => {
    expect(isOriginMutable("./relative")).toBe(false);
    expect(isOriginMutable("not-a-uri")).toBe(false);
    expect(isOriginMutable("")).toBe(false);
    // a `file:` URI that lacks an absolute path is rejected by parseOrigin,
    // so it must also be considered immutable here — the catalog's mutability
    // gate must not be bypassed by hand-crafting a relative file: ref.
    expect(isOriginMutable("file:./relative")).toBe(false);
  });

  it("ignores trailing path / case in the scheme decision", () => {
    expect(isOriginMutable("file:/abs/dir/with/many/segments/SKILL.md")).toBe(true);
  });
});

describe("ImmutableOriginError", () => {
  it("carries fqn + origin fields and a stable .name", () => {
    const e = new ImmutableOriginError("public/foo", "https://github.com/o/r/tree/main/x");
    expect(e.name).toBe("ImmutableOriginError");
    expect(e.fqn).toBe("public/foo");
    expect(e.origin).toBe("https://github.com/o/r/tree/main/x");
    expect(e.message).toContain("public/foo");
    expect(e.message).toContain("https://github.com/o/r/tree/main/x");
  });
});

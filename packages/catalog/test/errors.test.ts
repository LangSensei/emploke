import { describe, expect, it } from "vitest";
import {
  CatalogError,
  CatalogStateError,
  CycleDetected,
  FrontmatterError,
  HasDependents,
  MissingDependencies,
  NameInvalid,
  NotFound,
} from "../src/errors.js";

describe("Error hierarchy", () => {
  it("all errors extend CatalogError", () => {
    const errors = [
      new NameInvalid("x", "reason"),
      new MissingDependencies(["a"]),
      new CycleDetected(["a", "b"]),
      new HasDependents("x", ["y"]),
      new NotFound("skill", "x"),
      new FrontmatterError("path", "reason"),
      new CatalogStateError("msg"),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(CatalogError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("NameInvalid has correct properties", () => {
    const e = new NameInvalid("Bad", "uppercase");
    expect(e.invalidName).toBe("Bad");
    expect(e.reason).toBe("uppercase");
    expect(e.message).toContain("Bad");
  });

  it("NotFound has kind and missingName", () => {
    const e = new NotFound("mcp", "github");
    expect(e.kind).toBe("mcp");
    expect(e.missingName).toBe("github");
    expect(e.message).toContain("github");
  });

  it("HasDependents has target and dependents", () => {
    const e = new HasDependents("leaf", ["parent", "other"]);
    expect(e.target).toBe("leaf");
    expect(e.dependents).toEqual(["parent", "other"]);
  });

  it("CycleDetected has cycle path", () => {
    const e = new CycleDetected(["a", "b", "a"]);
    expect(e.cycle).toEqual(["a", "b", "a"]);
    expect(e.message).toContain("→");
  });

  it("FrontmatterError has path", () => {
    const e = new FrontmatterError("/foo/SKILL.md", "bad yaml");
    expect(e.path).toBe("/foo/SKILL.md");
  });

  it("error names match class names", () => {
    expect(new NameInvalid("x", "r").name).toBe("NameInvalid");
    expect(new NotFound("skill", "x").name).toBe("NotFound");
    expect(new CatalogStateError("x").name).toBe("CatalogStateError");
  });
});

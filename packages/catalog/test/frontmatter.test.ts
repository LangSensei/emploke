import { describe, expect, it } from "vitest";
import { FrontmatterError } from "../src/errors.js";
import { frontmatterToSkill, parseFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns empty data and full body when no frontmatter present", () => {
    const r = parseFrontmatter("# heading\n\nbody", "test.md");
    expect(r.data).toEqual({});
    expect(r.body).toBe("# heading\n\nbody");
  });

  it("parses YAML frontmatter and separates body", () => {
    const src = `---\nname: foo\ndescription: bar\n---\n\nbody text`;
    const r = parseFrontmatter(src, "test.md");
    expect(r.data).toEqual({ name: "foo", description: "bar" });
    expect(r.body).toBe("\nbody text");
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody";
    const r = parseFrontmatter(src, "test.md");
    expect(r.data).toEqual({ name: "foo", description: "bar" });
    expect(r.body).toBe("body");
  });

  it("treats empty frontmatter as empty data, not error", () => {
    const src = "---\n\n---\nbody";
    const r = parseFrontmatter(src, "test.md");
    expect(r.data).toEqual({});
    expect(r.body).toBe("body");
  });

  it("throws FrontmatterError when YAML is malformed", () => {
    const src = `---\nname: : :\n---\n`;
    expect(() => parseFrontmatter(src, "bad.md")).toThrow(FrontmatterError);
  });

  it("throws FrontmatterError when frontmatter is an array (not mapping)", () => {
    const src = `---\n- a\n- b\n---\n`;
    expect(() => parseFrontmatter(src, "arr.md")).toThrow(FrontmatterError);
  });
});

describe("frontmatterToSkill", () => {
  it("projects only the fields emploke cares about", () => {
    const skill = frontmatterToSkill(
      {
        name: "git-pr",
        description: "Open a PR",
        version: "1.2.3",
        type: "skill",
        prereq: "references/SETUP.md", // ignored
        license: "MIT", // ignored
        dependencies: { skills: ["sop"], mcps: ["swat"] },
      },
      "git-pr/SKILL.md",
    );
    expect(skill).toEqual({
      name: "git-pr",
      description: "Open a PR",
      version: "1.2.3",
      type: "skill",
      dependencies: { skills: ["sop"], mcps: ["swat"] },
    });
  });

  it("defaults version to 0.0.1 when frontmatter omits it", () => {
    const skill = frontmatterToSkill({ name: "a", description: "x" }, "a/SKILL.md");
    expect(skill.version).toBe("0.0.1");
  });

  it("omits type and dependencies when not present", () => {
    const skill = frontmatterToSkill({ name: "a", description: "x" }, "a/SKILL.md");
    expect(skill.type).toBeUndefined();
    expect(skill.dependencies).toBeUndefined();
  });

  it("throws when name is missing", () => {
    expect(() => frontmatterToSkill({ description: "x" }, "x.md")).toThrow(FrontmatterError);
  });

  it("throws when description is missing", () => {
    expect(() => frontmatterToSkill({ name: "a" }, "x.md")).toThrow(FrontmatterError);
  });

  it("throws when version is non-string", () => {
    expect(() => frontmatterToSkill({ name: "a", description: "x", version: 1 }, "x.md")).toThrow(
      FrontmatterError,
    );
  });

  it("throws when dependencies is not a mapping", () => {
    expect(() =>
      frontmatterToSkill({ name: "a", description: "x", dependencies: ["b"] }, "x.md"),
    ).toThrow(FrontmatterError);
  });

  it("throws when dependencies.skills is not an array of strings", () => {
    expect(() =>
      frontmatterToSkill({ name: "a", description: "x", dependencies: { skills: [1, 2] } }, "x.md"),
    ).toThrow(FrontmatterError);
  });

  it("accepts dependencies with only one of skills/mcps", () => {
    const a = frontmatterToSkill(
      { name: "a", description: "x", dependencies: { skills: ["b"] } },
      "x.md",
    );
    expect(a.dependencies).toEqual({ skills: ["b"] });

    const b = frontmatterToSkill(
      { name: "a", description: "x", dependencies: { mcps: ["m"] } },
      "x.md",
    );
    expect(b.dependencies).toEqual({ mcps: ["m"] });
  });
});

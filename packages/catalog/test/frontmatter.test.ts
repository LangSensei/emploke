import { describe, expect, it } from "vitest";
import { FrontmatterError } from "../src/errors.js";
import { frontmatterToAgent, frontmatterToSkill, parseFrontmatter } from "../src/frontmatter.js";

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
  it("projects MetaAgents fields and computes FQN from synthetic file: origin", () => {
    const skill = frontmatterToSkill(
      {
        name: "git-pr",
        description: "Open a PR",
        version: "1.2.3",
        type: "skill", // ignored — not in MetaAgents
        license: "MIT", // ignored
        dependencies: {
          skills: [{ name: "sop", origin: "file:/test/local/sop" }],
          mcps: [{ name: "swat", origin: "file:/test/local/swat" }],
        },
        prereqs: "Run setup.sh first",
      },
      "git-pr/SKILL.md",
    );
    expect(skill).toEqual({
      name: "local/git-pr",
      shortName: "git-pr",
      scope: "local",
      origin: "file:git-pr/SKILL.md",
      description: "Open a PR",
      version: "1.2.3",
      dependencies: {
        skills: [{ name: "sop", origin: "file:/test/local/sop" }],
        mcps: [{ name: "swat", origin: "file:/test/local/swat" }],
      },
      prereqs: "Run setup.sh first",
    });
  });

  it("uses defaultOrigin from opts when frontmatter omits origin", () => {
    const skill = frontmatterToSkill(
      { name: "weather", description: "x" },
      "weather/SKILL.md",
      { defaultOrigin: "https://github.com/anthropic/skills/tree/main/weather" },
    );
    expect(skill.origin).toBe("https://github.com/anthropic/skills/tree/main/weather");
    expect(skill.scope).toBe("anthropic");
    expect(skill.name).toBe("anthropic/weather");
  });

  it("frontmatter `scope` overrides scope-from-origin", () => {
    const skill = frontmatterToSkill(
      {
        name: "weather",
        description: "x",
        scope: "my-fork",
        origin: "https://github.com/anthropic/skills/tree/main/weather",
      },
      "x.md",
    );
    expect(skill.scope).toBe("my-fork");
    expect(skill.name).toBe("my-fork/weather");
  });

  it("defaults version to 0.0.1 when frontmatter omits it", () => {
    const skill = frontmatterToSkill({ name: "a", description: "x" }, "a/SKILL.md");
    expect(skill.version).toBe("0.0.1");
  });

  it("omits dependencies and prereqs when not present", () => {
    const skill = frontmatterToSkill({ name: "a", description: "x" }, "a/SKILL.md");
    expect(skill.dependencies).toBeUndefined();
    expect(skill.prereqs).toBeUndefined();
  });

  it("throws when name is missing", () => {
    expect(() => frontmatterToSkill({ description: "x" }, "x.md")).toThrow(FrontmatterError);
  });

  it("throws NameInvalid when name contains a slash (must be short name)", () => {
    expect(() =>
      frontmatterToSkill({ name: "scope/foo", description: "x" }, "x.md"),
    ).toThrow(/short name/);
  });

  it("throws when description is missing", () => {
    expect(() => frontmatterToSkill({ name: "a" }, "x.md")).toThrow(FrontmatterError);
  });

  it("throws when version is non-string", () => {
    expect(() => frontmatterToSkill({ name: "a", description: "x", version: 1 }, "x.md")).toThrow(
      FrontmatterError,
    );
  });

  it("throws when prereqs is non-string", () => {
    expect(() =>
      frontmatterToSkill({ name: "a", description: "x", prereqs: ["a"] }, "x.md"),
    ).toThrow(FrontmatterError);
  });

  it("throws when dependencies is not a mapping", () => {
    expect(() =>
      frontmatterToSkill({ name: "a", description: "x", dependencies: ["b"] }, "x.md"),
    ).toThrow(FrontmatterError);
  });

  it("throws when dependencies.skills entries are bare strings (post-#39 clean break)", () => {
    expect(() =>
      frontmatterToSkill(
        { name: "a", description: "x", dependencies: { skills: ["b"] } },
        "x.md",
      ),
    ).toThrow(FrontmatterError);
  });

  it("throws when a dependency ref omits origin", () => {
    expect(() =>
      frontmatterToSkill(
        { name: "a", description: "x", dependencies: { skills: [{ name: "b" }] } },
        "x.md",
      ),
    ).toThrow(FrontmatterError);
  });

  it("accepts dependencies with only one of skills/mcps", () => {
    const a = frontmatterToSkill(
      {
        name: "a",
        description: "x",
        dependencies: { skills: [{ name: "b", origin: "file:/test/local/b" }] },
      },
      "x.md",
    );
    expect(a.dependencies).toEqual({
      skills: [{ name: "b", origin: "file:/test/local/b" }],
    });

    const b = frontmatterToSkill(
      {
        name: "a",
        description: "x",
        dependencies: { mcps: [{ name: "m", origin: "file:/test/local/m" }] },
      },
      "x.md",
    );
    expect(b.dependencies).toEqual({
      mcps: [{ name: "m", origin: "file:/test/local/m" }],
    });
  });
});

describe("frontmatterToAgent", () => {
  it("parses agent frontmatter and computes FQN", () => {
    const agent = frontmatterToAgent(
      {
        name: "reviewer",
        scope: "langsensei",
        origin: "file:/test/langsensei/reviewer",
        description: "Reviews PRs",
        version: "1.0.0",
        dependencies: {
          skills: [{ name: "security-audit", origin: "file:/test/local/security-audit" }],
          mcps: [{ name: "github", origin: "file:/test/local/github" }],
        },
      },
      "AGENTS.md",
    );
    expect(agent).toEqual({
      name: "langsensei/reviewer",
      shortName: "reviewer",
      scope: "langsensei",
      origin: "file:/test/langsensei/reviewer",
      description: "Reviews PRs",
      version: "1.0.0",
      dependencies: {
        skills: [{ name: "security-audit", origin: "file:/test/local/security-audit" }],
        mcps: [{ name: "github", origin: "file:/test/local/github" }],
      },
    });
  });

  it("defaults version to 0.0.1", () => {
    const agent = frontmatterToAgent({ name: "a", description: "x" }, "AGENTS.md");
    expect(agent.version).toBe("0.0.1");
  });

  it("throws when name is missing", () => {
    expect(() => frontmatterToAgent({ description: "x" }, "AGENTS.md")).toThrow(FrontmatterError);
  });
});

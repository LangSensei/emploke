import { describe, expect, it } from "vitest";
import { SkillFrontmatterError, SkillNameInvalidError } from "../../src/skill/errors.js";
import { Skill } from "../../src/skill/skill-entity.js";

const MIN_VALID = `---
name: tool-use
description: Helpful patterns
version: 1.0.0
---
# Body
`;

describe("Skill.create", () => {
  it("returns an entity with derived FQN and exposed metadata", () => {
    const s = Skill.create(MIN_VALID, "file:/abs/skills/tool-use", "test");
    expect(s.fqn).toBe("public/tool-use");
    expect(s.scope).toBe("public");
    expect(s.origin).toBe("file:/abs/skills/tool-use");
    expect(s.description).toBe("Helpful patterns");
    expect(s.version).toBe("1.0.0");
    expect(s.prereqs).toBeUndefined();
    expect(s.dependencies).toEqual({ skills: [], mcps: [] });
  });

  it("preserves anchor bytes verbatim", () => {
    const s = Skill.create(MIN_VALID, "file:/abs/x", "test");
    expect(s.anchorContent).toBe(MIN_VALID);
  });

  it("derives FQN from explicit scope when present", () => {
    const src = MIN_VALID.replace("name: tool-use", "name: tool-use\nscope: io.example");
    const s = Skill.create(src, "file:/abs/x", "test");
    expect(s.fqn).toBe("io.example/tool-use");
  });

  it("rejects empty origin", () => {
    expect(() => Skill.create(MIN_VALID, "", "test")).toThrow(TypeError);
  });

  it("propagates frontmatter errors", () => {
    expect(() => Skill.create("# no frontmatter\n", "file:/abs/x", "test")).toThrow(
      SkillFrontmatterError,
    );
  });

  it("propagates name validation errors", () => {
    const src = MIN_VALID.replace("name: tool-use", "name: BadName");
    expect(() => Skill.create(src, "file:/abs/x", "test")).toThrow(SkillNameInvalidError);
  });
});

describe("Skill.fromStored", () => {
  it("trusts persisted state without re-parsing anchor", () => {
    const s = Skill.fromStored({
      fqn: "public/tool-use",
      origin: "file:/abs/x",
      scope: "public",
      shortName: "tool-use",
      description: "y",
      version: "2.0.0",
      prereqs: undefined,
      dependencies: { skills: [], mcps: [] },
      anchorContent: "garbage not parseable",
    });
    expect(s.fqn).toBe("public/tool-use");
    expect(s.anchorContent).toBe("garbage not parseable");
  });

  it("validates name (defensive — repos can't smuggle bad FQNs)", () => {
    expect(() =>
      Skill.fromStored({
        fqn: "no-slash-name",
        origin: "file:/abs/x",
        scope: "public",
        shortName: "x",
        description: "x",
        version: "1.0.0",
        prereqs: undefined,
        dependencies: { skills: [], mcps: [] },
        anchorContent: MIN_VALID,
      }),
    ).toThrow(SkillNameInvalidError);
  });
});

describe("Skill.withAnchor", () => {
  it("returns a new entity with updated description / version", () => {
    const s1 = Skill.create(MIN_VALID, "file:/abs/x", "test");
    const updated = `---
name: tool-use
description: Updated description
version: 2.0.0
---
# Body
`;
    const s2 = s1.withAnchor(updated, "test");
    expect(s2).not.toBe(s1);
    expect(s2.description).toBe("Updated description");
    expect(s2.version).toBe("2.0.0");
    expect(s2.name).toBe(s1.name); // identity preserved
    expect(s2.origin).toBe(s1.origin);
  });

  it("rejects scope change (would change identity)", () => {
    const s1 = Skill.create(MIN_VALID, "file:/abs/x", "test");
    const evil = MIN_VALID.replace("name: tool-use", "name: tool-use\nscope: io.evil");
    expect(() => s1.withAnchor(evil, "test")).toThrow(/cannot change identity/);
  });

  it("rejects short name change (would change identity)", () => {
    const s1 = Skill.create(MIN_VALID, "file:/abs/x", "test");
    const renamed = MIN_VALID.replace("name: tool-use", "name: renamed-tool");
    expect(() => s1.withAnchor(renamed, "test")).toThrow(/cannot change identity/);
  });
});

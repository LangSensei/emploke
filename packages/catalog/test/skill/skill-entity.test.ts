import { describe, expect, it } from "vitest";
import { SkillNameInvalidError } from "../../src/skill/errors.js";
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
    expect(s.scope).toBe("public"); // derived from fqn (catalog v2)
    expect(s.shortName).toBe("tool-use");
    expect(s.origin).toBe("file:/abs/skills/tool-use");
    expect(s.description).toBe("Helpful patterns");
    expect(s.version).toBe("1.0.0");
    expect(s.dependencies).toEqual({ skills: [], mcps: [] });
    expect(s.depsRefs).toEqual({ skills: [], mcps: [] });
    expect(s.installedAt).toBeTypeOf("string");
    expect(s.updatedAt).toBeTypeOf("string");
  });

  it("exposes frontmatter dep origins via depsRefs", () => {
    const src = `---
name: parent
description: x
version: 1.0.0
dependencies:
  skills:
    - "file:/abs/child"
  mcps:
    - "file:/abs/mcps/azure"
---
`;
    const s = Skill.create(src, "file:/abs/parent", "test");
    expect(s.depsRefs.skills).toEqual(["file:/abs/child"]);
    expect(s.depsRefs.mcps).toEqual(["file:/abs/mcps/azure"]);
    // fqn-form deps stay empty until the install pipeline writes the dep tables.
    expect(s.dependencies).toEqual({ skills: [], mcps: [] });
  });

  it("rejects empty origin", () => {
    expect(() => Skill.create(MIN_VALID, "", "test")).toThrow(TypeError);
  });
});

describe("Skill.fromStored", () => {
  it("trusts persisted state without re-parsing anchor", () => {
    const now = "2026-05-19T00:00:00.000Z";
    const s = Skill.fromStored({
      fqn: "public/tool-use",
      origin: "file:/abs/x",
      description: "y",
      version: "2.0.0",
      prereqs: undefined,
      dependencies: { skills: [{ fqn: "public/child" }], mcps: [] },
      prereqsAck: true,
      installedAt: now,
      updatedAt: now,
    });
    expect(s.fqn).toBe("public/tool-use");
    expect(s.dependencies.skills).toEqual([{ fqn: "public/child" }]);
    expect(s.installedAt).toBe(now);
  });

  it("validates name (defensive)", () => {
    expect(() =>
      Skill.fromStored({
        fqn: "no-slash",
        origin: "file:/abs/x",
        description: "x",
        version: "1.0.0",
        prereqs: undefined,
        dependencies: { skills: [], mcps: [] },
        prereqsAck: true,
        installedAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      }),
    ).toThrow(SkillNameInvalidError);
  });
});

describe("Skill.withAnchor", () => {
  it("returns a new entity with updated metadata, preserved identity", () => {
    const s1 = Skill.create(MIN_VALID, "file:/abs/x", "test");
    const updated = MIN_VALID.replace(
      "description: Helpful patterns",
      "description: Updated",
    ).replace("1.0.0", "2.0.0");
    const s2 = s1.withAnchor(updated, "test");
    expect(s2).not.toBe(s1);
    expect(s2.description).toBe("Updated");
    expect(s2.version).toBe("2.0.0");
    expect(s2.fqn).toBe(s1.fqn);
    expect(s2.origin).toBe(s1.origin);
  });

  it("rejects identity change", () => {
    const s1 = Skill.create(MIN_VALID, "file:/abs/x", "test");
    const renamed = MIN_VALID.replace("tool-use", "renamed-skill");
    expect(() => s1.withAnchor(renamed, "test")).toThrow(/cannot change identity/);
  });
});

describe("Skill.toJSON", () => {
  it("emits the v2 wire shape (no scope/shortName/anchorContent, with timestamps)", () => {
    const s = Skill.create(MIN_VALID, "file:/abs/x", "test");
    const json = s.toJSON();
    expect(json).toHaveProperty("fqn");
    expect(json).toHaveProperty("installedAt");
    expect(json).toHaveProperty("updatedAt");
    expect(json).not.toHaveProperty("scope");
    expect(json).not.toHaveProperty("shortName");
    expect(json).not.toHaveProperty("anchorContent");
  });
});

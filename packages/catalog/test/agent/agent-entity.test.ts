import { describe, expect, it } from "vitest";
import { AgentEntity } from "../../src/agent/agent-entity.js";
import { AgentFrontmatterError, AgentNameInvalidError } from "../../src/agent/errors.js";

const MIN_VALID = `---
name: researcher
description: Helpful researcher
version: 1.0.0
---
# Body
`;

describe("AgentEntity.create", () => {
  it("returns an entity with derived FQN and exposed metadata", () => {
    const a = AgentEntity.create(MIN_VALID, "file:/abs/agents/researcher", "test");
    expect(a.fqn).toBe("public/researcher");
    expect(a.scope).toBe("public");
    expect(a.shortName).toBe("researcher");
    expect(a.origin).toBe("file:/abs/agents/researcher");
    expect(a.description).toBe("Helpful researcher");
    expect(a.version).toBe("1.0.0");
    expect(a.dependencies).toEqual({ skills: [], mcps: [], agents: [] });
    expect(a.depsRefs).toEqual({ skills: [], mcps: [], agents: [] });
    expect(a.installedAt).toBeTypeOf("string");
  });

  it("rejects empty origin", () => {
    expect(() => AgentEntity.create(MIN_VALID, "", "test")).toThrow(TypeError);
  });

  it("propagates frontmatter errors", () => {
    expect(() => AgentEntity.create("# no frontmatter\n", "file:/abs/x", "test")).toThrow(
      AgentFrontmatterError,
    );
  });

  it("propagates name validation errors", () => {
    expect(() =>
      AgentEntity.create(MIN_VALID.replace("researcher", "BadName"), "file:/abs/x", "test"),
    ).toThrow(AgentNameInvalidError);
  });
});

describe("AgentEntity.fromStored", () => {
  it("trusts persisted state without re-parsing anchor", () => {
    const now = "2026-05-19T00:00:00.000Z";
    const a = AgentEntity.fromStored({
      fqn: "public/researcher",
      origin: "file:/abs/x",
      description: "y",
      version: "2.0.0",
      prereqs: undefined,
      dependencies: { skills: [], mcps: [], agents: [] },
      prereqsAck: true,
      disabledByUser: false,
      installedAt: now,
      updatedAt: now,
    });
    expect(a.fqn).toBe("public/researcher");
    expect(a.scope).toBe("public");
    expect(a.installedAt).toBe(now);
  });

  it("validates name (defensive)", () => {
    expect(() =>
      AgentEntity.fromStored({
        fqn: "no-slash",
        origin: "file:/abs/x",
        description: "x",
        version: "1.0.0",
        prereqs: undefined,
        dependencies: { skills: [], mcps: [], agents: [] },
        prereqsAck: true,
        disabledByUser: false,
        installedAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      }),
    ).toThrow(AgentNameInvalidError);
  });
});

describe("AgentEntity.withAnchor", () => {
  it("returns a new entity with updated metadata, preserved identity", () => {
    const a1 = AgentEntity.create(MIN_VALID, "file:/abs/x", "test");
    const updated = MIN_VALID.replace(
      "description: Helpful researcher",
      "description: Updated",
    ).replace("1.0.0", "2.0.0");
    const a2 = a1.withAnchor(updated, "test");
    expect(a2).not.toBe(a1);
    expect(a2.description).toBe("Updated");
    expect(a2.version).toBe("2.0.0");
    expect(a2.fqn).toBe(a1.fqn);
    expect(a2.origin).toBe(a1.origin);
  });

  it("rejects scope change", () => {
    const a1 = AgentEntity.create(MIN_VALID, "file:/abs/x", "test");
    const evil = MIN_VALID.replace("name: researcher", "name: researcher\nscope: io.evil");
    expect(() => a1.withAnchor(evil, "test")).toThrow(/cannot change identity/);
  });

  it("rejects short name change", () => {
    const a1 = AgentEntity.create(MIN_VALID, "file:/abs/x", "test");
    const renamed = MIN_VALID.replace("researcher", "renamed-agent");
    expect(() => a1.withAnchor(renamed, "test")).toThrow(/cannot change identity/);
  });
});

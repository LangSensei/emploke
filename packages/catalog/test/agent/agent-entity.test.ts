import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent-entity.js";
import { AgentFrontmatterError, AgentNameInvalidError } from "../../src/agent/errors.js";

const MIN_VALID = `---
name: researcher
description: Helpful researcher
version: 1.0.0
---
# Body
`;

describe("Agent.create", () => {
  it("returns an entity with derived FQN and exposed metadata", () => {
    const a = Agent.create(MIN_VALID, "file:/abs/agents/researcher", "test");
    expect(a.fqn).toBe("public/researcher");
    expect(a.scope).toBe("public");
    expect(a.origin).toBe("file:/abs/agents/researcher");
    expect(a.description).toBe("Helpful researcher");
    expect(a.version).toBe("1.0.0");
    expect(a.dependencies).toEqual({ skills: [], mcps: [] });
  });

  it("preserves anchor bytes verbatim", () => {
    const a = Agent.create(MIN_VALID, "file:/abs/x", "test");
    expect(a.anchorContent).toBe(MIN_VALID);
  });

  it("rejects empty origin", () => {
    expect(() => Agent.create(MIN_VALID, "", "test")).toThrow(TypeError);
  });

  it("propagates frontmatter errors", () => {
    expect(() => Agent.create("# no frontmatter\n", "file:/abs/x", "test")).toThrow(
      AgentFrontmatterError,
    );
  });

  it("propagates name validation errors", () => {
    expect(() =>
      Agent.create(MIN_VALID.replace("researcher", "BadName"), "file:/abs/x", "test"),
    ).toThrow(AgentNameInvalidError);
  });
});

describe("Agent.fromStored", () => {
  it("trusts persisted state without re-parsing anchor", () => {
    const a = Agent.fromStored({
      fqn: "public/researcher",
      origin: "file:/abs/x",
      scope: "public",
      shortName: "researcher",
      description: "y",
      version: "2.0.0",
      dependencies: { skills: [], mcps: [] },
      anchorContent: "garbage",
    });
    expect(a.fqn).toBe("public/researcher");
    expect(a.anchorContent).toBe("garbage");
  });

  it("validates name (defensive)", () => {
    expect(() =>
      Agent.fromStored({
        fqn: "no-slash",
        origin: "file:/abs/x",
        scope: "public",
        shortName: "x",
        description: "x",
        version: "1.0.0",
        dependencies: { skills: [], mcps: [] },
        anchorContent: MIN_VALID,
      }),
    ).toThrow(AgentNameInvalidError);
  });
});

describe("Agent.withAnchor", () => {
  it("returns a new entity with updated metadata, preserved identity", () => {
    const a1 = Agent.create(MIN_VALID, "file:/abs/x", "test");
    const updated = MIN_VALID.replace(
      "description: Helpful researcher",
      "description: Updated",
    ).replace("1.0.0", "2.0.0");
    const a2 = a1.withAnchor(updated, "test");
    expect(a2).not.toBe(a1);
    expect(a2.description).toBe("Updated");
    expect(a2.version).toBe("2.0.0");
    expect(a2.name).toBe(a1.name);
    expect(a2.origin).toBe(a1.origin);
  });

  it("rejects scope change", () => {
    const a1 = Agent.create(MIN_VALID, "file:/abs/x", "test");
    const evil = MIN_VALID.replace("name: researcher", "name: researcher\nscope: io.evil");
    expect(() => a1.withAnchor(evil, "test")).toThrow(/cannot change identity/);
  });

  it("rejects short name change", () => {
    const a1 = Agent.create(MIN_VALID, "file:/abs/x", "test");
    const renamed = MIN_VALID.replace("researcher", "renamed-agent");
    expect(() => a1.withAnchor(renamed, "test")).toThrow(/cannot change identity/);
  });
});

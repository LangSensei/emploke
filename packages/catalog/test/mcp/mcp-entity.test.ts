import { describe, expect, it } from "vitest";
import { McpInvalidJsonError, McpNameInvalidError } from "../../src/mcp/errors.js";
import { Mcp } from "../../src/mcp/mcp-entity.js";
import * as McpFormat from "../../src/mcp/mcp-format.js";

describe("Mcp.create", () => {
  it("validates name and origin, returns an entity with parseable spec", () => {
    const m = Mcp.create("azure/mcp", "file:/abs/azure", '{"command":"node"}');
    expect(m.fqn).toBe("azure/mcp");
    expect(m.origin).toBe("file:/abs/azure");
    expect(m.installedAt).toBeTypeOf("string");
    const { meta, body } = McpFormat.parse(m.spec, "test");
    expect(meta).toEqual({ name: "azure/mcp" });
    expect(body.command).toBe("node");
  });

  it("injects _meta.name when input lacks one", () => {
    const m = Mcp.create("x/y", "file:/abs/x", '{"command":"node"}');
    const parsed = JSON.parse(m.spec);
    expect(parsed._meta).toEqual({ name: "x/y" });
    expect(parsed.command).toBe("node");
  });

  it("rejects invalid name", () => {
    expect(() => Mcp.create("no-slash", "file:/abs/x", "{}")).toThrow(McpNameInvalidError);
    expect(() => Mcp.create("two/slashes/here", "file:/abs/x", "{}")).toThrow(McpNameInvalidError);
  });

  it("rejects empty origin", () => {
    expect(() => Mcp.create("x/y", "", "{}")).toThrow(TypeError);
  });

  it("rejects unparseable content", () => {
    expect(() => Mcp.create("x/y", "file:/abs/x", "{not json")).toThrow(McpInvalidJsonError);
  });

  it("accepts empty content (creates fresh _meta-only object)", () => {
    const m = Mcp.create("x/y", "file:/abs/x", "");
    const parsed = JSON.parse(m.spec);
    expect(parsed._meta).toEqual({ name: "x/y" });
  });
});

describe("Mcp.fromStored", () => {
  it("trusts persisted spec (no parse, no inject)", () => {
    const stored = '{"raw":"stored","_meta":{"name":"x/y"}}\n';
    const now = "2026-05-19T00:00:00.000Z";
    const m = Mcp.fromStored("x/y", "file:/abs/x", stored, now, now);
    expect(m.spec).toBe(stored);
    expect(m.installedAt).toBe(now);
  });

  it("still validates the name", () => {
    const now = "2026-05-19T00:00:00.000Z";
    expect(() => Mcp.fromStored("no-slash", "file:/abs/x", "{}", now, now)).toThrow(
      McpNameInvalidError,
    );
  });
});

describe("Mcp.withContent", () => {
  it("returns a new entity with replaced spec, identity preserved", () => {
    const m1 = Mcp.create("x/y", "file:/abs/x", '{"v":1}');
    const m2 = m1.withContent('{"v":2}');
    expect(m2.fqn).toBe(m1.fqn);
    expect(m2.origin).toBe(m1.origin);
    expect(JSON.parse(m2.spec).v).toBe(2);
  });
});

describe("Mcp.toJSON", () => {
  it("emits v2 wire shape: fqn (not name), no spec, with timestamps", () => {
    const m = Mcp.create("x/y", "file:/abs/x", "{}");
    const json = m.toJSON();
    expect(json).toHaveProperty("fqn", "x/y");
    expect(json).toHaveProperty("installedAt");
    expect(json).toHaveProperty("updatedAt");
    expect(json).not.toHaveProperty("name");
    expect(json).not.toHaveProperty("spec");
  });
});
